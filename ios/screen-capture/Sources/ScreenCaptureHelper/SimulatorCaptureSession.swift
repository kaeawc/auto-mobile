import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

/// Streams BGRA frames from a single iOS Simulator window via ScreenCaptureKit.
/// Targets up to 60fps; the writer trims to the frame protocol on the way out.
final class SimulatorCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: FrameWriter
    private let queue = DispatchQueue(label: "automobile.simulator-capture.frames")
    private var stream: SCStream?

    init(writer: FrameWriter) {
        self.writer = writer
    }

    private static let kTargetFPS: Int32 = 60

    func start(window: SCWindow) async throws {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        // Logical (points) size; the delivered CVPixelBuffer is in native
        // pixels (2x/3x for Retina), and downstream consumers must use
        // CVPixelBufferGetWidth/Height — not these values — to allocate sinks.
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(
            value: 1,
            timescale: SimulatorCaptureSession.kTargetFPS
        )
        config.showsCursor = false
        config.scalesToFit = false

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
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

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.isValid else { return }
        writer.write(sampleBuffer: sampleBuffer)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(
            Data("error: ScreenCaptureKit stream stopped: \(error)\n".utf8)
        )
    }
}
