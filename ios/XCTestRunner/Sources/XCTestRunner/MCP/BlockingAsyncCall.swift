import Foundation
import os

/// Temporary bridge for synchronous XCTest bodies, which normally run on the main thread. The
/// awaited runner path must stay free of main-actor and main-queue hops: blocking the main thread
/// while awaiting that work would deadlock. NEVER call from the cooperative pool or @MainActor-
/// isolated async code: blocking may starve the executor needed by the task and deadlock.
/// There is intentionally no separate semaphore timer: the async transport owns its deadline, and
/// time queued at the daemon gate must not count against a per-call backstop. Removed after PR 3.
enum BlockingAsyncCall {
    static func run<Value: Sendable>(_ operation: @escaping @Sendable () async throws -> Value) throws -> Value {
        let semaphore = DispatchSemaphore(value: 0)
        let result = OSAllocatedUnfairLock<Result<Value, any Error>?>(initialState: nil)
        Task.detached {
            do {
                let value = try await operation()
                result.withLock { $0 = .success(value) }
            } catch {
                result.withLock { $0 = .failure(error) }
            }
            semaphore.signal()
        }
        semaphore.wait()
        guard let completion = result.withLock({ $0 }) else {
            throw MCPClientError.requestFailed("Request failed without response")
        }
        return try completion.get()
    }
}
