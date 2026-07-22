import AVFoundation
import CoreVideo
import Foundation
import ScreenCaptureCore

/// Wraps an `AVCaptureSession` configured to deliver BGRA frames from an iOS
/// device to a `FrameWriter`.
final class DeviceCaptureSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let writer: FrameWriter
    private let onFatalError: (Error) -> Void
    private let queue = DispatchQueue(label: "automobile.screen-capture.frames")
    private var observers: [NSObjectProtocol] = []
    private var stopping = false

    init(writer: FrameWriter, onFatalError: @escaping (Error) -> Void) {
        self.writer = writer
        self.onFatalError = onFatalError
    }

    deinit {
        removeObservers()
    }

    func start(device: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: device)

        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CaptureError.couldNotAddInput
        }
        session.addInput(input)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
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
        writer.write(sampleBuffer: sampleBuffer)
    }
}
