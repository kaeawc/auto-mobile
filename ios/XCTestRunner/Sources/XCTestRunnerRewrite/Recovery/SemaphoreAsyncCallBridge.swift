import Foundation

/// Production bridge: runs the async work on the cooperative pool and blocks the executor thread on a
/// **bounded** semaphore wait. Blocking the executor thread is safe (it is the XCTest thread, not a
/// cooperative-pool thread); the timeout guarantees the wait cannot block indefinitely. On timeout the
/// spawned `Task` is cancelled so a cancellation-aware provider can drop its request promptly. Stateless
/// value type → `Sendable`.
struct SemaphoreAsyncCallBridge: AsyncCallBridging {
    func run<T: Sendable>(timeout: TimeInterval, _ operation: @escaping @Sendable () async throws -> T) throws -> T {
        let box = ResultBox<T>()
        let semaphore = DispatchSemaphore(value: 0)
        let task = Task {
            do {
                box.result = .success(try await operation())
            } catch {
                box.result = .failure(error)
            }
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            // Cancel the abandoned work so a cancellation-aware provider can release its network
            // request and drop its retained state promptly, rather than one orphaned task per
            // timed-out recovery accumulating for the lifetime of the XCTest process.
            task.cancel()
            throw RecoveryTimeoutError(timeoutSeconds: timeout)
        }
        switch box.result {
        case let .success(value):
            return value
        case let .failure(error):
            throw error
        case .none:
            throw MCPClientError.requestFailed("Recovery model call produced no result")
        }
    }
}

/// Mutable, thread-crossing result holder for `SemaphoreAsyncCallBridge`. `@unchecked Sendable`
/// because access is serialized by the semaphore (the write happens-before `signal()`; the read
/// happens-after a successful `wait()`), and on timeout the box is never read again.
private final class ResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}
