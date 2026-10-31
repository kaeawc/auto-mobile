import Foundation

/// One completion claim shared by callbacks and task cancellation. Later completions are ignored.
/// The lock also protects registration: cancellation may win before the continuation exists.
public final class SdkContinuationResumeOnce<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?

    fileprivate init() {}

    @discardableResult
    public func resume(returning value: Value) -> Bool {
        complete(.success(value))
    }

    @discardableResult
    public func resume(throwing error: Error) -> Bool {
        complete(.failure(error))
    }

    /// Claim before cleanup, since cancelling a transport can synchronously call its handler.
    /// Publish the result after cleanup so the awaiting task observes cleanup as complete.
    @discardableResult
    fileprivate func complete(_ result: Result<Value, Error>, beforeResume: () -> Void = {}) -> Bool {
        lock.lock()
        guard !claimed else {
            lock.unlock()
            return false
        }
        claimed = true
        lock.unlock()

        beforeResume()

        lock.lock()
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
        return true
    }

    /// Returns whether the caller should start work. If cancellation is still cleaning up,
    /// leave the continuation registered for that winner to resume when cleanup finishes.
    fileprivate func install(_ continuation: CheckedContinuation<Value, Error>) -> Bool {
        lock.lock()
        let result = self.result
        let shouldStart = !claimed
        if result == nil {
            self.continuation = continuation
        }
        lock.unlock()
        if let result {
            continuation.resume(with: result)
        }
        return shouldStart
    }
}

/// Cancels pending work and throws CancellationError even if its callback never arrives.
/// Create any resources captured by onCancel before calling this function; an already-cancelled
/// task runs cleanup before the body. Cleanup runs once, only when cancellation wins completion.
public func withCancellableCheckedContinuation<Value: Sendable>(
    _ body: @Sendable (SdkContinuationResumeOnce<Value>) -> Void,
    onCancel: @escaping @Sendable () -> Void
)
    async throws -> Value
{
    let once = SdkContinuationResumeOnce<Value>()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            guard once.install(continuation) else { return }
            guard !Task.isCancelled else {
                once.complete(.failure(CancellationError()), beforeResume: onCancel)
                return
            }
            body(once)
        }
    } onCancel: {
        once.complete(.failure(CancellationError()), beforeResume: onCancel)
    }
}

/// Races an operation against an injectable sleep. The body must cooperate with cancellation,
/// including any callback-based waits, so the task group can drain after the timeout wins.
public func withSdkTimeout<Value: Sendable>(
    seconds: UInt64,
    timeoutError: Error,
    _ body: @escaping @Sendable () async throws -> Value,
    sleep: @escaping @Sendable (UInt64) async throws -> Void = {
        try await Task.sleep(nanoseconds: $0 * 1_000_000_000)
    }
)
    async throws -> Value
{
    try await withThrowingTaskGroup(of: Value.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await sleep(seconds)
            throw timeoutError
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw timeoutError }
        return result
    }
}
