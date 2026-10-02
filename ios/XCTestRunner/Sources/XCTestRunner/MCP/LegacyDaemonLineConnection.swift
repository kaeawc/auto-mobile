import Foundation
import os

/// Legacy test seam, retained byte-for-byte at the call sites until PR 3. Production uses the async seam.
protocol DaemonLineConnectionFactory {
    func makeConnection(socketPath: String) -> DaemonLineConnection
}

/// Legacy implementations must support cancel concurrent with a blocking operation. No production
/// implementation remains; this seam exists solely for the pre-migration synchronous test doubles.
protocol DaemonLineConnection: AnyObject {
    func connect(timeout: TimeInterval) throws
    func sendLine(_ data: Data, timeout: TimeInterval) throws
    func receiveLine(timeout: TimeInterval) throws -> Data
    func cancel()
}

/// Owns a non-Sendable legacy factory behind a short lock. The client gate serializes construction.
/// Removed in PR 3 alongside the old seam; no new production implementation should use this adapter.
final class LegacyDaemonLineConnectionFactory: AsyncDaemonLineConnectionFactory, Sendable {
    private let factory: OSAllocatedUnfairLock<any DaemonLineConnectionFactory>

    init(_ factory: any DaemonLineConnectionFactory) {
        self.factory = OSAllocatedUnfairLock(uncheckedState: factory)
    }

    func makeConnection(socketPath: String) -> any AsyncDaemonLineConnection {
        factory.withLockUnchecked { LegacyDaemonLineConnection($0.makeConnection(socketPath: socketPath)) }
    }
}

/// Unchecked only for the owned legacy object: request access is serialized by the client gate and
/// cancel is the legacy seam's explicit concurrent interrupt. Blocking work runs on GCD, not a pool
/// thread; cancellation releases the checked wait even if old code returns later. Removed in PR 3.
private final class LegacyDaemonLineConnection: AsyncDaemonLineConnection, @unchecked Sendable {
    private let connection: any DaemonLineConnection
    private struct State: Sendable {
        var cancelled = false
        var pending: [ObjectIdentifier: @Sendable () -> Void] = [:]
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    init(_ connection: any DaemonLineConnection) { self.connection = connection }

    func connect(timeout: TimeInterval) async throws {
        try await run { try self.connection.connect(timeout: timeout) }
    }

    func sendLine(_ data: Data, timeout: TimeInterval) async throws {
        try await run { try self.connection.sendLine(data, timeout: timeout) }
    }

    func receiveLine(timeout: TimeInterval) async throws -> Data {
        try await run { try self.connection.receiveLine(timeout: timeout) }
    }

    private func run<Value: Sendable>(_ operation: @escaping @Sendable () throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        let result = SingleResumeCell<Value>()
        defer { state.withLock { _ = $0.pending.removeValue(forKey: ObjectIdentifier(result)) } }
        let cancelled = state.withLock { current in
            guard !current.cancelled else { return true }
            current.pending[ObjectIdentifier(result)] = {
                result.resume(throwing: MCPClientError.requestFailed("Daemon connection cancelled"))
            }
            return false
        }
        if cancelled { result.resume(throwing: MCPClientError.requestFailed("Daemon connection cancelled")) }
        return try await withTaskCancellationHandler {
            DispatchQueue.global().async {
                guard !result.isResolved else { return }
                do { try result.resume(returning: operation()) }
                catch { result.resume(throwing: error) }
            }
            return try await result.wait()
        } onCancel: {
            result.cancel()
            self.cancel()
        }
    }

    func cancel() {
        let pending = state.withLock { current -> [@Sendable () -> Void]? in
            guard !current.cancelled else { return nil }
            current.cancelled = true
            let pending = Array(current.pending.values)
            current.pending.removeAll()
            return pending
        }
        guard let pending else { return }
        for completion in pending {
            completion()
        }
        connection.cancel()
    }
}
