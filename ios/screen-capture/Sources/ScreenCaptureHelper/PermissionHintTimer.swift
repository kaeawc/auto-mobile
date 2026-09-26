import Foundation
import ScreenCaptureCore

/// Installs the Screen Recording hint on its own queue. Keeping the event
/// handler in this nonisolated type avoids inheriting main.swift's MainActor
/// context, which traps when Dispatch invokes a top-level closure off-main.
final class PermissionHintTimer: @unchecked Sendable {
    private let firstFrameSignal: FirstFrameSignal
    private let approvalTarget: String
    private let output: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "automobile.simulator-capture.permission-hint")
    private var timer: DispatchSourceTimer?

    init(
        firstFrameSignal: FirstFrameSignal,
        approvalTarget: String,
        output: @escaping @Sendable (String) -> Void = { line in
            FileHandle.standardError.write(Data("\(line)\n".utf8))
        }
    ) {
        self.firstFrameSignal = firstFrameSignal
        self.approvalTarget = approvalTarget
        self.output = output
    }

    func arm(after seconds: TimeInterval) {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + seconds)
        timer.setEventHandler { [weak self] in self?.emitIfNeeded() }
        self.timer = timer
        timer.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func emitIfNeeded() {
        guard !firstFrameSignal.hasReceivedFrame else { return }
        output(CapturePermissionMarker.line(.screenRecording))
        output(CapturePermissionTargetMarker.line(approvalTarget))
        output("error: Screen Recording permission is required to discover and observe iOS Simulator windows.")
    }
}
