import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

/// The subset of `SCStream` operations `SimulatorCaptureSession` drives. Wrapping
/// them in a protocol is the seam that lets unit tests inject a fake stream and
/// exercise the session's lifecycle paths (start/stop/reconfigure/fatal-error)
/// without a real Simulator window or Screen Recording permission (issue #4771).
/// The signatures match `SCStream`'s exactly so it conforms without adapters.
protocol CaptureStream: AnyObject {
    func addStreamOutput(
        _ output: SCStreamOutput,
        type: SCStreamOutputType,
        sampleHandlerQueue: DispatchQueue?
    ) throws
    func removeStreamOutput(_ output: SCStreamOutput, type: SCStreamOutputType) throws
    func startCapture() async throws
    func stopCapture() async throws
    func updateConfiguration(_ configuration: SCStreamConfiguration) async throws
}

extension SCStream: CaptureStream {}

/// Streams BGRA frames from a single iOS Simulator window via ScreenCaptureKit.
/// The frame rate is configurable (5–60); 5 is the default for typical MCP
/// automation workloads. Size changes (e.g. device rotation) trigger a stream
/// reconfiguration so frames don't get cropped.
final class SimulatorCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Builds the concrete stream for a resolved window. Injected so tests can
    /// substitute a fake `CaptureStream`; the default wires the real `SCStream`.
    typealias StreamFactory = (SCContentFilter, SCStreamConfiguration, SCStreamDelegate) -> CaptureStream

    private let writer: FrameWriter
    private let onFatalError: (Error) -> Void
    private let makeStream: StreamFactory
    /// In-helper H.264 encode settings (issue #4788). `nil` keeps the default
    /// raw-BGRA path byte-for-byte unchanged.
    private let encodeSettings: CommandLineOptions.EncodeSettings?
    /// Force-keyframe latch shared with the STDIN control channel; consumed by
    /// the encoder on the next frame. Present even in raw mode (harmless there).
    let forceKeyFrameLatch = ForceKeyFrameLatch()
    /// Active encoder in `--encode h264` mode; recreated on a capture-size
    /// change (seamless reconfig: the new session's first frame is a fresh
    /// SPS/PPS + IDR).
    private var encoder: H264VideoEncoder?
    /// Pixel format requested from ScreenCaptureKit — 32BGRA for the raw path,
    /// 420v (NV12) for the lowest-CPU encode path.
    var configuredPixelFormat: OSType = kCVPixelFormatType_32BGRA
    /// Diagnostic lines (first-frame marker, reconfigure warnings) go here so
    /// tests can observe them; the default preserves the stderr behavior.
    private let diagnosticSink: (String) -> Void
    private let queue = DispatchQueue(label: "automobile.simulator-capture.frames")
    let firstFrameSignal = FirstFrameSignal()

    // The following are `internal` (not `private`) so `@testable` tests can seed
    // and inspect lifecycle state that `start()` would otherwise set only behind
    // a real `SCWindow`. They are not part of the production API surface.
    var stream: CaptureStream?
    var configuredPixelWidth: Int = 0
    var configuredPixelHeight: Int = 0
    var fps: Int = CommandLineOptions.defaultSimulatorFPS
    var audioEnabled = false
    var windowID: UInt32 = 0

    /// Upper bound on `stream.startCapture()`. ScreenCaptureKit cold-start on
    /// hosted `macos26` runners is slow-but-finite (measured 2.6–13s); this
    /// deadline sits above that healthy window yet below the parent supervisor's
    /// 15s first-frame SIGTERM (`IOS_FIRST_FRAME_TIMEOUT_MS`), so a genuinely
    /// hung start is surfaced as a specific `error:` line rather than silent
    /// frame starvation. See issues #4350 / #4764.
    static let startCaptureDeadlineSeconds: TimeInterval = 14.0

    init(
        writer: FrameWriter,
        makeStream: @escaping StreamFactory = { filter, config, delegate in
            SCStream(filter: filter, configuration: config, delegate: delegate)
        },
        diagnosticSink: @escaping (String) -> Void = { line in
            FileHandle.standardError.write(Data(line.utf8))
        },
        encode: CommandLineOptions.EncodeSettings? = nil,
        onFatalError: @escaping (Error) -> Void
    ) {
        self.writer = writer
        self.makeStream = makeStream
        self.diagnosticSink = diagnosticSink
        self.encodeSettings = encode
        self.onFatalError = onFatalError
    }

    /// Whether this session encodes H.264 in-process instead of streaming raw
    /// BGRA.
    var isEncoding: Bool { encodeSettings != nil }

    func start(window: SCWindow, fps: Int, audio: Bool) async throws {
        self.fps = fps
        audioEnabled = audio
        windowID = window.windowID
        // 420v (NV12) is the lowest-CPU encode input: the delivered
        // IOSurface-backed CVPixelBuffer feeds VTCompressionSession directly with
        // no color conversion. The raw path keeps 32BGRA untouched.
        if isEncoding {
            configuredPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SimulatorCaptureSession.makeConfiguration(
            window: window, fps: fps, audio: audio, pixelFormat: configuredPixelFormat
        )
        configuredPixelWidth = config.width
        configuredPixelHeight = config.height

        let stream = makeStream(filter, config, self)
        try await beginCapture(with: stream, audio: audio)
    }

    /// Wires outputs onto an already-built stream and starts it. Split out from
    /// `start()` so tests can drive it with a fake `CaptureStream` — the window
    /// resolution and filter/config construction above need real SCK objects.
    func beginCapture(with stream: CaptureStream, audio: Bool) async throws {
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if audio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        }
        try await SimulatorCaptureSession.startCapture(stream)
        self.stream = stream
    }

    /// Races `stream.startCapture()` against `startCaptureDeadlineSeconds`.
    ///
    /// A hung `startCapture()` does not honor Swift task cancellation, so a
    /// structured `withThrowingTaskGroup` would block on teardown awaiting the
    /// very task we are trying to abandon. Instead the two arms run as
    /// unstructured tasks and the first to finish wins; on timeout the stalled
    /// capture task is left to be reaped by process exit, which the parent
    /// triggers immediately after seeing the `error:` diagnostic.
    private static func startCapture(_ stream: CaptureStream) async throws {
        let race = StartRaceState()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let capture = Task {
                do {
                    try await stream.startCapture()
                    if race.finish() { continuation.resume() }
                } catch {
                    if race.finish() { continuation.resume(throwing: error) }
                }
            }
            Task {
                let deadlineNanos = UInt64(startCaptureDeadlineSeconds * 1_000_000_000)
                try? await Task.sleep(nanoseconds: deadlineNanos)
                if race.finish() {
                    capture.cancel()
                    continuation.resume(
                        throwing: StartCaptureTimeoutError(deadlineSeconds: startCaptureDeadlineSeconds)
                    )
                }
            }
        }
    }

    func stop() async {
        encoder?.stop()
        encoder = nil
        guard let stream = stream else { return }
        // removeStreamOutput breaks the SCStream → self retain cycle so the
        // session is collectable even before SCStream itself goes away.
        try? stream.removeStreamOutput(self, type: .screen)
        try? await stream.stopCapture()
        self.stream = nil
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid else { return }
        if type == .audio {
            if let pcm16le = pcm16leAudio(sampleBuffer: sampleBuffer) {
                writer.writeAudio(pcm16le: pcm16le)
            }
            return
        }
        guard type == .screen else { return }

        // Drop non-complete statuses (idle, blank, suspended, stopped) so we
        // don't re-emit identical pixels or partial buffers.
        if let status = SimulatorCaptureSession.frameStatus(of: sampleBuffer),
           status != .complete {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let actualWidth = CVPixelBufferGetWidth(pixelBuffer)
        let actualHeight = CVPixelBufferGetHeight(pixelBuffer)

        if isEncoding {
            encodeScreenFrame(
                pixelBuffer: pixelBuffer, sampleBuffer: sampleBuffer,
                width: actualWidth, height: actualHeight
            )
            return
        }

        if actualWidth != configuredPixelWidth || actualHeight != configuredPixelHeight {
            reconfigure(width: actualWidth, height: actualHeight)
        }

        if writer.write(sampleBuffer: sampleBuffer) {
            noteFrameWritten(width: actualWidth, height: actualHeight)
        }
    }

    /// Encode-mode screen path (issue #4788). Converges the ScreenCaptureKit
    /// output size to the Level 4.2 macroblock-budgeted encode resolution — so
    /// SCK does the downscale, not a separate stage — then feeds the delivered
    /// 420v buffer straight to VideoToolbox. On a size change the encoder is torn
    /// down and recreated (seamless reconfig); the new session's first frame is a
    /// fresh SPS/PPS + IDR.
    private func encodeScreenFrame(
        pixelBuffer: CVPixelBuffer,
        sampleBuffer: CMSampleBuffer,
        width: Int,
        height: Int
    ) {
        let target = H264EncodeMath.resolveEncoderScale(
            H264EncodeMath.EncoderSize(width: width, height: height)
        ) ?? H264EncodeMath.EncoderSize(width: width, height: height)

        // Ask SCK to deliver the encode resolution. Until it does, skip encoding
        // rather than feed VideoToolbox a mismatched buffer size.
        if width != target.width || height != target.height {
            reconfigure(width: target.width, height: target.height)
            return
        }

        // Delivered size now equals the encode target. (Re)create the encoder if
        // absent or sized for a previous resolution.
        if encoder == nil || encoder?.width != target.width || encoder?.height != target.height {
            guard startEncoder(width: target.width, height: target.height) else { return }
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if encoder?.encode(pixelBuffer: pixelBuffer, presentationTime: pts) == true {
            noteFrameWritten(width: target.width, height: target.height)
        }
    }

    /// Build and start a VideoToolbox encoder at `width`x`height`, resolving the
    /// `AverageBitRate` from the delivered dimensions per the operator's bitrate
    /// choice. Returns `false` (and surfaces a fatal error) when the session
    /// cannot be created.
    private func startEncoder(width: Int, height: Int) -> Bool {
        encoder?.stop()
        let bitrate = resolvedBitrateBps(width: width, height: height)
        let newEncoder = H264VideoEncoder(
            width: width,
            height: height,
            fps: fps,
            averageBitRateBps: bitrate,
            writer: writer,
            forceKeyFrameLatch: forceKeyFrameLatch,
            diagnosticSink: diagnosticSink,
            onFatalError: { [weak self] message in
                self?.onFatalError(EncoderOutputOverflowError(message: message))
            }
        )
        do {
            try newEncoder.start()
        } catch {
            onFatalError(error)
            return false
        }
        encoder = newEncoder
        return true
    }

    /// Resolve `AverageBitRate` (bps) from the delivered pixel dimensions and the
    /// operator's bitrate choice. `nil` leaves the VideoToolbox default. The
    /// policy (which choice) is set by the TS supervisor via CLI flags; only the
    /// pixel-dimension arithmetic — which the helper alone knows pre-encode —
    /// happens here, via the pure `H264EncodeMath`.
    private func resolvedBitrateBps(width: Int, height: Int) -> Int? {
        switch encodeSettings?.bitrate {
        case .explicitBps(let bps):
            return bps
        case .bitsPerPixel(let bpp):
            return H264EncodeMath.bitrateBps(width: width, height: height, fps: fps, bitsPerPixel: bpp)
        case .videoToolboxDefault, .none:
            return nil
        }
    }

    /// Emits the first-frame marker exactly once and records that frames are
    /// flowing. Split out from the frame callback so tests can assert the
    /// once-only marker emission without synthesizing a `CMSampleBuffer`.
    func noteFrameWritten(width: Int, height: Int) {
        if !firstFrameSignal.hasReceivedFrame {
            // Emitted from the frame queue to confirm the source actually
            // started delivering frames — the "captureStarted but no
            // firstFrame" distinction issue #4350 needs.
            let marker = CaptureStartupMarker.line(
                .firstFrame(windowID: windowID, width: width, height: height)
            )
            diagnosticSink("\(marker)\n")
        }
        firstFrameSignal.markReceivedFrame()
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        handleFatalStop(error: error)
    }

    /// Routes a stream stop to the fatal-error handler. Split out from the
    /// delegate callback so tests can drive it without a real `SCStream`.
    func handleFatalStop(error: Error) {
        onFatalError(error)
    }

    // MARK: - Internals

    private func reconfigure(width: Int, height: Int) {
        // Detached task: the retry inside `performReconfiguration` bounds the
        // recovery so a single transient `updateConfiguration` failure does not
        // silently strand the stream at stale dimensions (issue #4768).
        Task {
            await performReconfiguration(width: width, height: height)
        }
    }

    /// Applies a new capture size to the live stream. Split out from
    /// `reconfigure`'s detached task so tests can `await` it deterministically
    /// and assert both the success path and the swallowed-failure warning.
    func performReconfiguration(width: Int, height: Int) async {
        guard let stream = stream else { return }
        configuredPixelWidth = width
        configuredPixelHeight = height

        let updated = SCStreamConfiguration()
        updated.width = width
        updated.height = height
        updated.pixelFormat = configuredPixelFormat
        updated.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        updated.showsCursor = false
        updated.scalesToFit = false
        updated.capturesAudio = audioEnabled
        updated.sampleRate = 8_000
        updated.channelCount = 1

        // Retry once on failure before giving up: `updateConfiguration` can fail
        // transiently while ScreenCaptureKit is mid-frame, and silently keeping
        // the stale config would drift delivered pixels away from the size the
        // supervisor expects — which the TS side then kills on as a mismatch.
        // The new dimensions are already recorded above, so on ultimate failure
        // the next size change still attempts a correcting update.
        do {
            try await stream.updateConfiguration(updated)
            return
        } catch {
            diagnosticSink("warn: stream configuration update failed; retrying once: \(error)\n")
        }

        do {
            try await stream.updateConfiguration(updated)
        } catch {
            diagnosticSink("warn: failed to update stream configuration after retry: \(error)\n")
        }
    }

    private static func makeConfiguration(
        window: SCWindow,
        fps: Int,
        audio: Bool,
        pixelFormat: OSType = kCVPixelFormatType_32BGRA
    ) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        // Logical (points) size; the delivered CVPixelBuffer is in native
        // pixels (2x/3x for Retina), and downstream consumers must use
        // CVPixelBufferGetWidth/Height — not these values — to allocate sinks.
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        config.pixelFormat = pixelFormat
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.showsCursor = false
        config.scalesToFit = false
        config.capturesAudio = audio
        config.sampleRate = 8_000
        config.channelCount = 1
        return config
    }

    private static func frameStatus(of sampleBuffer: CMSampleBuffer) -> SCFrameStatus? {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let info = attachments.first,
            let rawStatus = info[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            return nil
        }
        return status
    }
}

/// Thrown when `SimulatorCaptureSession` gives up waiting on `startCapture()`.
/// Conforms to `CustomStringConvertible` so `main.swift`'s `error:` line names
/// the stalled startup stage (`starting-capture` seen, `capture-started`
/// absent), letting the parent supervisor fail fast with a specific cause
/// instead of frame starvation. See issues #4350 / #4764.
/// Raised when the encoder's bounded output queue overflows (issue #4788). The
/// encoded path never drops an emitted record, so overflow is fatal: `main.swift`
/// exits and the supervisor relaunches the helper with a fresh IDR.
struct EncoderOutputOverflowError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

struct StartCaptureTimeoutError: Error, CustomStringConvertible {
    let deadlineSeconds: TimeInterval

    var description: String {
        "startCapture() exceeded \(deadlineSeconds)s deadline "
            + "(stage: starting-capture seen, capture-started absent)"
    }
}

/// Single-winner guard for the `startCapture()` deadline race. `finish()`
/// returns `true` exactly once, so the checked continuation is resumed by
/// whichever arm — capture or timeout — completes first.
final class StartRaceState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false

    func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        return true
    }
}

/// Cross-queue state shared by the ScreenCaptureKit frame callback and the
/// main-run-loop permission hint. Every access is protected by `lock`.
final class FirstFrameSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var receivedFrame = false

    var hasReceivedFrame: Bool {
        lock.lock()
        defer { lock.unlock() }
        return receivedFrame
    }

    func markReceivedFrame() {
        lock.lock()
        receivedFrame = true
        lock.unlock()
    }
}
