import Foundation
import ScreenCaptureCore

/// Installs the Screen Recording hint on its own queue. Keeping the event
/// handler in this nonisolated type avoids inheriting main.swift's MainActor
/// context, which traps when Dispatch invokes a top-level closure off-main.
final class PermissionHintTimer: @unchecked Sendable {
    private let firstFrameSignal: FirstFrameSignal
    private let approvalTarget: String
    private let output: @Sendable (String) -> Void
    private let schedule: @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> @Sendable () -> Void
    private var cancelTimer: (@Sendable () -> Void)?

    init(
        firstFrameSignal: FirstFrameSignal,
        approvalTarget: String,
        schedule: @escaping @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> @Sendable ()
            -> Void = { seconds, action in
                let timer = DispatchSource
                    .makeTimerSource(queue: DispatchQueue(label: "automobile.simulator-capture.permission-hint"))
                timer.schedule(deadline: .now() + seconds)
                timer.setEventHandler(handler: action)
                timer.resume()
                return { timer.cancel() }
            },
        output: @escaping @Sendable (String) -> Void = { line in
            DescriptorWrite.writeDiagnostic("\(line)\n")
        }
    ) {
        self.firstFrameSignal = firstFrameSignal
        self.approvalTarget = approvalTarget
        self.schedule = schedule
        self.output = output
    }

    func arm(after seconds: TimeInterval) {
        guard cancelTimer == nil else { return }
        cancelTimer = schedule(seconds) { [weak self] in self?.emitIfNeeded() }
    }

    func stop() {
        cancelTimer?()
        cancelTimer = nil
    }

    func emitIfNeeded() {
        guard !firstFrameSignal.hasReceivedFrame else { return }
        output(CapturePermissionMarker.line(.screenRecording))
        output(CapturePermissionTargetMarker.line(approvalTarget))
        output("error: Screen Recording permission is required to discover and observe iOS Simulator windows.")
    }
}
