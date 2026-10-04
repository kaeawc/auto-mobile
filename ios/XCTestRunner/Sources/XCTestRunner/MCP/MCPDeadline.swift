import Foundation

enum TimeoutConversion {
    /// 24 hours, matching DaemonManager.maximumReceiveTimeoutSeconds.
    static let maximumSeconds: TimeInterval = 24 * 60 * 60

    /// Clamp seconds to 0...maximumSeconds. NaN, zero and negative values (including -infinity)
    /// become zero; +infinity and values above the maximum become 24 hours.
    static func clampedSeconds(_ seconds: TimeInterval) -> TimeInterval {
        guard !seconds.isNaN else { return 0 }
        return min(max(seconds, 0), maximumSeconds)
    }

    /// Convert clamped seconds to daemon wire milliseconds without trapping. Truncate fractional
    /// milliseconds toward zero, preserving the existing Int(seconds * 1000) behavior in range.
    static func milliseconds(forSeconds seconds: TimeInterval) -> Int {
        Int(clampedSeconds(seconds) * 1000)
    }
}

/// Cancellation-aware async delay shared by transport deadlines, recovery and executor retries.
/// Implementations must release their sleep when cancelled; tests inject virtual time.
public protocol DeadlineScheduler: Sendable {
    func sleep(seconds: TimeInterval) async throws
}

/// Task.sleep releases the executor thread and reacts to cancellation of a losing deadline task.
/// Delays are clamped to 24 hours; NaN and non-positive values become zero.
public struct SystemDeadlineScheduler: DeadlineScheduler {
    public init() {}
    public func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(TimeoutConversion.clampedSeconds(seconds)))
    }
}

/// Races an operation against one deadline without joining an operation that ignores cancellation.
/// Only the single-resume cell owns completion. Losing tasks are cancelled outside locks; an
/// uncooperative operation may retain its captures until it finishes, but its late result is inert.
/// Detached tasks inherit neither actor isolation nor task locals: routing must be explicit values.
func withDeadline<Value: Sendable>(
    seconds: TimeInterval,
    scheduler: any DeadlineScheduler,
    onTimeout: @escaping @Sendable () -> Void = {},
    timeoutError: @autoclosure @escaping @Sendable () -> any Error,
    operation: @escaping @Sendable () async throws -> Value
)
    async throws -> Value
{
    try Task.checkCancellation()
    let result = SingleResumeCell<Value>()
    let worker = Task.detached(priority: Task.currentPriority) {
        do {
            try Task.checkCancellation()
            let value = try await operation()
            result.resume(returning: value)
        } catch {
            result.resume(throwing: error)
        }
    }
    let deadline = Task.detached(priority: Task.currentPriority) {
        do {
            try await scheduler.sleep(seconds: seconds)
            try Task.checkCancellation()
            if result.resume(throwing: timeoutError()) { onTimeout() }
        } catch {
            // The losing timer's cancellation must not replace the winning result.
            if !Task.isCancelled { result.resume(throwing: error) }
        }
    }
    let completion: Result<Value, any Error>
    do {
        let value = try await withTaskCancellationHandler {
            try await result.wait()
        } onCancel: {
            result.cancel()
            worker.cancel()
            deadline.cancel()
        }
        completion = .success(value)
    } catch {
        completion = .failure(error)
    }
    worker.cancel()
    deadline.cancel()
    // Join only the cancellation-aware scheduler, so timeout teardown finishes before returning.
    await deadline.value
    return try completion.get()
}
