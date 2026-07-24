import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

/// Streams BGRA frames from a single iOS Simulator window via ScreenCaptureKit.
/// The frame rate is configurable (5–60); 5 is the default for typical MCP
/// automation workloads. Size changes (e.g. device rotation) trigger a stream
/// reconfiguration so frames don't get cropped.
final class SimulatorCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: FrameWriter
    private let onFatalError: (Error) -> Void
    private let queue = DispatchQueue(label: "automobile.simulator-capture.frames")
    private var stream: SCStream?
    private var configuredPixelWidth: Int = 0
    private var configuredPixelHeight: Int = 0
    private var hasReceivedFrame = false
    private var fps: Int = CommandLineOptions.defaultSimulatorFPS
    private var audioEnabled = false
    private var windowID: UInt32 = 0

    init(writer: FrameWriter, onFatalError: @escaping (Error) -> Void) {
        self.writer = writer
        self.onFatalError = onFatalError
    }

    func start(window: SCWindow, fps: Int, audio: Bool) async throws {
        self.fps = fps
        audioEnabled = audio
        windowID = window.windowID
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SimulatorCaptureSession.makeConfiguration(window: window, fps: fps, audio: audio)
        configuredPixelWidth = config.width
        configuredPixelHeight = config.height

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if audio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        }
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        guard let stream = stream else { return }
        // removeStreamOutput breaks the SCStream → self retain cycle so the
        // session is collectable even before SCStream itself goes away.
        try? stream.removeStreamOutput(self, type: .screen)
        try? await stream.stopCapture()
        self.stream = nil
    }

    /// Whether at least one frame has been delivered since `start()`.
    /// Used by the CLI to detect a silent screen-recording permission denial.
    var hasReceivedAnyFrame: Bool { hasReceivedFrame }

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
        if actualWidth != configuredPixelWidth || actualHeight != configuredPixelHeight {
            reconfigure(width: actualWidth, height: actualHeight)
        }

        if writer.write(sampleBuffer: sampleBuffer) {
            if !hasReceivedFrame {
                // Emitted from the frame queue, not the (possibly parked) main
                // thread, so it survives to confirm the source actually started
                // delivering frames — the "captureStarted but no firstFrame"
                // distinction issue #4350 needs.
                let marker = CaptureStartupMarker.line(
                    .firstFrame(windowID: windowID, width: actualWidth, height: actualHeight)
                )
                FileHandle.standardError.write(Data("\(marker)\n".utf8))
            }
            hasReceivedFrame = true
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onFatalError(error)
    }

    // MARK: - Internals

    private func reconfigure(width: Int, height: Int) {
        guard let stream = stream else { return }
        configuredPixelWidth = width
        configuredPixelHeight = height

        let updated = SCStreamConfiguration()
        updated.width = width
        updated.height = height
        updated.pixelFormat = kCVPixelFormatType_32BGRA
        updated.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        updated.showsCursor = false
        updated.scalesToFit = false
        updated.capturesAudio = audioEnabled
        updated.sampleRate = 8_000
        updated.channelCount = 1

        // Fire-and-forget: if the update fails we keep using the old config and
        // either resync on the next size change or stop with a delegate error.
        Task {
            do {
                try await stream.updateConfiguration(updated)
            } catch {
                FileHandle.standardError.write(
                    Data("warn: failed to update stream configuration: \(error)\n".utf8)
                )
            }
        }
    }

    private static func makeConfiguration(window: SCWindow, fps: Int, audio: Bool) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        // Logical (points) size; the delivered CVPixelBuffer is in native
        // pixels (2x/3x for Retina), and downstream consumers must use
        // CVPixelBufferGetWidth/Height — not these values — to allocate sinks.
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        config.pixelFormat = kCVPixelFormatType_32BGRA
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
