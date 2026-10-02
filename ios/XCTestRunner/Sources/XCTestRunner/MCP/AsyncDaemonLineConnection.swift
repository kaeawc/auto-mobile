import Foundation
import Network
import os

/// One cancellation-aware, newline-framed socket. cancel never waits for I/O and releases all waits.
protocol AsyncDaemonLineConnection: AnyObject, Sendable {
    func connect(timeout: TimeInterval) async throws
    func sendLine(_ data: Data, timeout: TimeInterval) async throws
    func receiveLine(timeout: TimeInterval) async throws -> Data
    func cancel()
}

/// Construction does no I/O; connect runs within the client's per-operation deadline.
protocol AsyncDaemonLineConnectionFactory: Sendable {
    func makeConnection(socketPath: String) -> any AsyncDaemonLineConnection
}

/// Production always uses native Network.framework continuations, never the legacy sync adapter.
struct NWAsyncDaemonLineConnectionFactory: AsyncDaemonLineConnectionFactory {
    func makeConnection(socketPath: String) -> any AsyncDaemonLineConnection {
        NWAsyncDaemonLineConnection(socketPath: socketPath)
    }
}

/// Network.framework owns its callback queue; all framing, lifecycle and pending-operation state is
/// additionally lock-confined because cancellation/reset may arrive on any thread. NWConnection is
/// itself Sendable. Each callback and teardown competes through the same SingleResumeCell.
final class NWAsyncDaemonLineConnection: AsyncDaemonLineConnection, Sendable {
    private struct State: Sendable {
        var started = false
        var ready = false
        var failure: (any Error)?
        var buffer = Data()
        var pending: [ObjectIdentifier: @Sendable (any Error) -> Void] = [:]
    }

    private let connection: NWConnection
    private let queue = DispatchQueue(label: "AutoMobileDaemonClient")
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(socketPath: String) {
        connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
    }

    func connect(timeout _: TimeInterval) async throws {
        try Task.checkCancellation()
        if state.withLock({ $0.ready && $0.failure == nil }) { return }
        let cell = SingleResumeCell<Void>()
        defer { unregister(cell) }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                cell.install(continuation)
                guard register(cell) else { return }
                let start = state.withLock { current in
                    guard !current.started, current.failure == nil else { return false }
                    current.started = true
                    return true
                }
                if start {
                    connection.stateUpdateHandler = { [weak self] update in
                        guard let self else { return }
                        switch update {
                        case .ready:
                            let ready = self.state.withLock { current in
                                current.ready = current.failure == nil
                                return current.ready
                            }
                            if ready { cell.resume(returning: ()) }
                        case let .failed(error): self.failAll(error)
                        case .cancelled: self.failAll(MCPClientError.requestFailed("Daemon connection cancelled"))
                        default: break
                        }
                    }
                    connection.start(queue: queue)
                }
            }
        } onCancel: {
            cell.cancel()
            self.cancel()
        }
    }

    func sendLine(_ data: Data, timeout _: TimeInterval) async throws {
        let cell = SingleResumeCell<Void>()
        defer { unregister(cell) }
        try Task.checkCancellation()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                cell.install(continuation)
                guard register(cell) else { return }
                connection.send(content: data, completion: .contentProcessed { error in
                    if let error { cell.resume(throwing: error) }
                    else { cell.resume(returning: ()) }
                })
            }
        } onCancel: {
            cell.cancel()
            self.cancel()
        }
    }

    func receiveLine(timeout _: TimeInterval) async throws -> Data {
        let cell = SingleResumeCell<Data>()
        defer { unregister(cell) }
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                cell.install(continuation)
                guard register(cell) else { return }
                receiveChunk(cell)
            }
        } onCancel: {
            cell.cancel()
            self.cancel()
        }
    }

    private func register<Value>(_ cell: SingleResumeCell<Value>) -> Bool {
        let (registered, failure) = state.withLock { current -> (Bool, (any Error)?) in
            guard !cell.isResolved else { return (false, nil) }
            if let failure = current.failure {
                return (false, failure)
            }
            current.pending[ObjectIdentifier(cell)] = { cell.resume(throwing: $0) }
            return (true, nil)
        }
        if let failure { cell.resume(throwing: failure) }
        return registered
    }

    private func unregister<Value>(_ cell: SingleResumeCell<Value>) {
        state.withLock { _ = $0.pending.removeValue(forKey: ObjectIdentifier(cell)) }
    }

    private func receiveChunk(_ cell: SingleResumeCell<Data>) {
        let (shouldReceive, line) = state.withLock { current -> (Bool, Data?) in
            guard current.failure == nil, !cell.isResolved else { return (false, nil) }
            if let range = current.buffer.firstRange(of: Data([0x0A])) {
                let line = current.buffer.subdata(in: 0 ..< range.lowerBound)
                current.buffer.removeSubrange(0 ... range.lowerBound)
                return (false, line)
            }
            return (true, nil)
        }
        if let line { cell.resume(returning: line) }
        guard shouldReceive else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, complete, error in
            state.withLock { current in
                if current.failure == nil, !cell.isResolved, let data { current.buffer.append(data) }
            }
            if let error { failAll(error); return }
            // Preserve a final complete line even when EOF accompanies its bytes.
            if complete {
                let line = state.withLock { current -> Data? in
                    if current.failure == nil, let range = current.buffer.firstRange(of: Data([0x0A])) {
                        let line = current.buffer.subdata(in: 0 ..< range.lowerBound)
                        current.buffer.removeSubrange(0 ... range.lowerBound)
                        return line
                    }
                    return nil
                }
                if let line { cell.resume(returning: line) }
                failAll(MCPClientError.requestFailed("Daemon connection closed"))
                return
            }
            receiveChunk(cell)
        }
    }

    private func failAll(_ error: any Error) {
        let pending = state.withLock { current in
            if current.failure == nil { current.failure = error }
            current.ready = false
            current.buffer = Data()
            let pending = current.pending
            current.pending.removeAll()
            return pending
        }
        for completion in pending.values {
            completion(error)
        }
    }

    func cancel() {
        failAll(MCPClientError.requestFailed("Daemon connection cancelled"))
        connection.cancel()
    }
}
