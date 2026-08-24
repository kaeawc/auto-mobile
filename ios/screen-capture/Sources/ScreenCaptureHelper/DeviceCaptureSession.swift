import AVFoundation
import CoreVideo
import Foundation
import ScreenCaptureCore

/// Wraps an `AVCaptureSession` configured to stream frames from a USB-connected
/// iOS device to a `FrameWriter`.
///
/// Two paths (issue #4790): the default raw path delivers 32BGRA and streams it
/// byte-for-byte as before; `--encode h264` delivers 420v (NV12) and feeds the
/// delivered `CVPixelBuffer` straight into the SAME `EncodePipeline` /
/// `H264VideoEncoder` stage the Simulator path uses, emitting Annex-B
/// encoded-video records. AVFoundation accepts 420v directly with no color
/// conversion, so the encode input is the lowest-CPU form.
final class DeviceCaptureSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let writer: FrameWriter
    private let onFatalError: (Error) -> Void
    private let diagnosticSink: (String) -> Void
    /// In-helper H.264 encode settings (issue #4790). `nil` keeps the raw-BGRA
    /// path byte-for-byte unchanged.
    private let encodeSettings: CommandLineOptions.EncodeSettings?
    /// Force-keyframe latch shared with the STDIN control channel; consumed by the
    /// encoder on the next frame. Present even in raw mode (harmless there).
    let forceKeyFrameLatch = ForceKeyFrameLatch()
    /// Shared in-helper encode wiring in `--encode h264` mode; `nil` on the raw
    /// path. Identical `EncodePipeline` type as the Simulator session. Guarded by
    /// `stateLock` because `captureOutput` reads it on the frame `queue` while
    /// `stop()` clears it off-queue.
    private var _pipeline: EncodePipeline?
    /// Guards `_pipeline` across the frame `queue` and `stop()`.
    private let stateLock = NSLock()
    private let queue = DispatchQueue(label: "automobile.screen-capture.frames")
    private var observers: [NSObjectProtocol] = []
    private var stopping = false

    init(
        writer: FrameWriter,
        encode: CommandLineOptions.EncodeSettings? = nil,
        diagnosticSink: @escaping (String) -> Void = { line in
            FileHandle.standardError.write(Data(line.utf8))
        },
        onFatalError: @escaping (Error) -> Void
    ) {
        self.writer = writer
        self.encodeSettings = encode
        self.diagnosticSink = diagnosticSink
        self.onFatalError = onFatalError
    }

    deinit {
        removeObservers()
    }

    /// Whether this session encodes H.264 in-process instead of streaming raw
    /// BGRA.
    var isEncoding: Bool { encodeSettings != nil }

    func start(device: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: device)

        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CaptureError.couldNotAddInput
        }
        session.addInput(input)

        if let encodeSettings = encodeSettings {
            // 420v (NV12) feeds VideoToolbox directly with no color conversion.
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            ]
            // Drop policy (issue #4790): the encode path relies SOLELY on #4788's
            // encoder-input drop (`EncoderDropPolicy.shouldDropBeforeEncode`), which
            // is the only backpressure that can see the real encoder state
            // (in-flight frames) and always drops BEFORE encode, leaving the encoded
            // reference chain intact. `alwaysDiscardsLateVideoFrames` is therefore
            // turned OFF here so we do NOT stack a second, encoder-blind drop layer
            // at the capture edge that could over-drop frames the encoder was ready
            // to accept. The delegate never blocks (VideoToolbox encode is
            // fire-and-forget and the input drop returns immediately when behind), so
            // AVFoundation does not accumulate late frames without the discard.
            output.alwaysDiscardsLateVideoFrames = false
            // Set before `startRunning()`, i.e. before frames flow, so a direct
            // field write is safe here.
            _pipeline = EncodePipeline(
                writer: writer,
                fps: DeviceCaptureSession.deviceFPS,
                source: .device,
                bitrate: encodeSettings.bitrate,
                forceKeyFrameLatch: forceKeyFrameLatch,
                diagnosticSink: diagnosticSink,
                onFatalError: onFatalError
            )
        } else {
            // Raw path unchanged: newest-wins late-frame discard at the capture
            // edge, 32BGRA delivery.
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
        }

        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CaptureError.couldNotAddOutput
        }
        session.addOutput(output)
        session.commitConfiguration()
        installObservers()
        session.startRunning()
        guard session.isRunning else {
            throw CaptureError.didNotStart
        }
    }

    func stop() {
        stopping = true
        removeObservers()
        session.stopRunning()

        stateLock.lock()
        let pipeline = _pipeline
        _pipeline = nil
        stateLock.unlock()
        // Tear the encoder down ON the frame queue so it cannot overlap an in-flight
        // `captureOutput` encode call (both run on `queue`); `queue.sync` waits for any
        // executing frame callback first, avoiding a use-after-free on the VideoToolbox
        // session. `stopRunning()` above stops future delivery but does not guarantee an
        // already-dispatched callback has returned.
        if let pipeline = pipeline {
            queue.sync { pipeline.stop() }
        }
    }

    private func installObservers() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(
                forName: AVCaptureSession.runtimeErrorNotification,
                object: session,
                queue: .main
            ) { [weak self] notification in
                let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                    ?? CaptureError.runtimeFailure
                self?.reportFatal(error)
            },
            center.addObserver(
                forName: AVCaptureSession.wasInterruptedNotification,
                object: session,
                queue: .main
            ) { [weak self] _ in
                self?.reportFatal(CaptureError.interrupted)
            },
        ]
    }

    private func removeObservers() {
        let center = NotificationCenter.default
        observers.forEach(center.removeObserver)
        observers = []
    }

    private func reportFatal(_ error: Error) {
        guard !stopping else { return }
        onFatalError(error)
    }

    private enum CaptureError: LocalizedError {
        case couldNotAddInput
        case couldNotAddOutput
        case didNotStart
        case runtimeFailure
        case interrupted

        var errorDescription: String? {
            switch self {
            case .couldNotAddInput: return "Unable to add the iOS capture input."
            case .couldNotAddOutput: return "Unable to add the iOS capture output."
            case .didNotStart: return "The iOS capture session did not start."
            case .runtimeFailure: return "The iOS capture session reported a runtime failure."
            case .interrupted: return "The iOS capture session was interrupted."
            }
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        stateLock.lock()
        let pipeline = _pipeline
        stateLock.unlock()
        if let pipeline = pipeline {
            encodeFrame(pipeline: pipeline, sampleBuffer: sampleBuffer)
            return
        }
        writer.write(sampleBuffer: sampleBuffer)
    }

    /// Encode-mode frame path (issue #4790). Unlike the Simulator path — which
    /// asks ScreenCaptureKit to deliver the Level 4.2 macroblock-budgeted size —
    /// AVFoundation cannot reshape its delivery size, so the encoder is sized to
    /// the budgeted target and VideoToolbox scales the native buffer into it. On a
    /// delivered-size change the encoder is torn down and recreated (the new
    /// session's first frame is a fresh SPS/PPS + IDR).
    private func encodeFrame(pipeline: EncodePipeline, sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let target = H264EncodeMath.resolveEncoderScale(
            H264EncodeMath.EncoderSize(width: width, height: height)
        ) ?? H264EncodeMath.EncoderSize(width: width, height: height)

        guard pipeline.ensureEncoder(width: target.width, height: target.height) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        pipeline.encode(pixelBuffer: pixelBuffer, presentationTime: pts)
    }

    /// Frame rate declared to the encoder for `MaxKeyFrameInterval` /
    /// bitrate arithmetic. AVFoundation device capture is not FPS-throttled by the
    /// helper (the device pushes frames at its own cadence), so this mirrors the
    /// Simulator default used elsewhere rather than a negotiated rate.
    static let deviceFPS = CommandLineOptions.defaultSimulatorFPS
}
