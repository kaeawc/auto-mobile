import Foundation

/// One total deadline and cancellation gate for DNS, connect, TLS, I/O and every redirect.
/// No user callback, continuation, task or connection is invoked while holding the lock.
final class PrototypePinnedCall: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<PrototypeHttpResponse, Error>?
    private var continuation: CheckedContinuation<PrototypeHttpResponse, Error>?
    private var task: Task<Void, Never>?
    private var deadline: (@Sendable () -> Void)?
    private var connection: (any PrototypePinnedConnection)?

    var active: Bool { lock.withLock { result == nil } }

    func install(_ continuation: CheckedContinuation<PrototypeHttpResponse, Error>) {
        let finished: Result<PrototypeHttpResponse, Error>? = lock.withLock {
            if let result { return result }
            self.continuation = continuation
            return nil
        }
        if let finished { continuation.resume(with: finished) }
    }

    func install(task: Task<Void, Never>) {
        let ended = lock.withLock {
            guard result == nil else { return true }
            self.task = task
            return false
        }
        if ended { task.cancel() }
    }

    func install(deadline: @escaping @Sendable () -> Void) {
        let ended = lock.withLock {
            guard result == nil else { return true }
            self.deadline = deadline
            return false
        }
        if ended { deadline() }
    }

    func install(connection: any PrototypePinnedConnection) throws {
        let ended = lock.withLock {
            guard result == nil else { return true }
            self.connection = connection
            return false
        }
        if ended { connection.cancel(); throw CancellationError() }
    }

    func finish(_ outcome: Result<PrototypeHttpResponse, Error>) {
        let cleanup: (@Sendable () -> Void)? = lock.withLock {
            guard result == nil else { return nil }
            result = outcome
            let continuation = self.continuation
            let task = self.task
            let deadline = self.deadline
            let connection = self.connection
            self.continuation = nil
            self.task = nil
            self.deadline = nil
            self.connection = nil
            return {
                deadline?()
                connection?.cancel()
                task?.cancel()
                continuation?.resume(with: outcome)
            }
        }
        cleanup?()
    }
}
