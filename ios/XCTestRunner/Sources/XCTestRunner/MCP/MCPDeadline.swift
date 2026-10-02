import Foundation

/// Separate from the public synchronous timer so transport deadlines can suspend and be cancelled
/// without changing the executor's timing API during the first migration step.
protocol DeadlineScheduler: Sendable {
    func sleep(seconds: TimeInterval) async throws
}

/// Task.sleep releases the executor thread and reacts to cancellation of a losing deadline task.
struct SystemDeadlineScheduler: DeadlineScheduler {
    func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(max(0, seconds)))
    }
}

/// Races one bounded, cancellation-aware operation against its deadline. A shared cell arbitrates
/// timeout, result, and outer cancellation before cancelling the losing child. Children must release
/// their waits on cancellation; structured concurrency joins them before returning. Late callbacks
/// cannot replace the winning result. onTimeout tears down daemon I/O only when timeout actually wins.
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
    return try await withTaskCancellationHandler {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                do {
                    try Task.checkCancellation()
                    try result.resume(returning: await operation())
                } catch {
                    result.resume(throwing: error)
                }
            }
            group.addTask {
                do {
                    try await scheduler.sleep(seconds: seconds)
                    try Task.checkCancellation()
                    if result.resume(throwing: timeoutError()) { onTimeout() }
                } catch {
                    // Cancellation of the losing timer must not replace the operation's result.
                    if !Task.isCancelled { result.resume(throwing: error) }
                }
            }
            defer { group.cancelAll() }
            return try await result.wait()
        }
    } onCancel: {
        result.cancel()
    }
}
