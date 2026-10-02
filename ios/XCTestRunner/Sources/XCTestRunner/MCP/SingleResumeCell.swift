import Foundation
import os

/// Owns a checked continuation's terminal result under a short lock. Completion may precede
/// installation, including cancellation; the first result wins and callbacks after teardown are inert.
/// Call resume/cancel outside of any lock that a cancellation handler can take, because handlers
/// run synchronously under the cancelled task's status lock.
final class SingleResumeCell<Value: Sendable>: Sendable {
    private struct State: Sendable {
        var continuation: CheckedContinuation<Value, any Error>?
        var result: Result<Value, any Error>?
        var installed = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    var isResolved: Bool { state.withLock { $0.result != nil } }

    func install(_ continuation: CheckedContinuation<Value, any Error>) {
        let result = state.withLock { current -> Result<Value, any Error>? in
            precondition(!current.installed, "A continuation cell can only be installed once")
            current.installed = true
            if let result = current.result { return result }
            current.continuation = continuation
            return nil
        }
        if let result { continuation.resume(with: result) }
    }

    @discardableResult
    func resume(returning value: Value) -> Bool { finish(.success(value)) }

    @discardableResult
    func resume(throwing error: any Error) -> Bool { finish(.failure(error)) }

    @discardableResult
    func cancel() -> Bool { resume(throwing: CancellationError()) }

    private func finish(_ result: Result<Value, any Error>) -> Bool {
        let completion = state.withLock { current -> (Bool, CheckedContinuation<Value, any Error>?) in
            guard current.result == nil else { return (false, nil) }
            current.result = result
            let continuation = current.continuation
            current.continuation = nil
            return (true, continuation)
        }
        completion.1?.resume(with: result)
        return completion.0
    }

    /// Disable cell cancellation when an enclosing handler owns cleanup and resolution, as in the
    /// serial gate. Transport waits use cancellation and release their I/O.
    func wait(cancellable: Bool = true) async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { install($0) }
        } onCancel: {
            if cancellable { self.cancel() }
        }
    }
}
