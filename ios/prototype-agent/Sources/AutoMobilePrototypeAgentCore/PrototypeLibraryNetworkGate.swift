import Foundation

/// Consent is scoped to an epoch. All mutable state is protected by the lock; callbacks run outside it.
public final class PrototypeLibraryNetworkGate: @unchecked Sendable {
    private let lock = NSLock()
    private var enabled: Bool
    private var epoch: UInt64 = 0
    private var observers: [UUID: @Sendable () -> Void] = [:]

    public init(enabled: Bool = false) { self.enabled = enabled }

    public func setEnabled(_ value: Bool) {
        let callbacks: [@Sendable () -> Void] = lock.withLock {
            guard enabled != value else { return [] }
            enabled = value
            guard !value else { return [] }
            epoch += 1
            let callbacks = Array(observers.values)
            observers.removeAll()
            return callbacks
        }
        for callback in callbacks {
            callback()
        }
    }

    func snapshot() -> UInt64? { lock.withLock { enabled ? epoch : nil } }
    func permits(_ captured: UInt64) -> Bool { lock.withLock { enabled && epoch == captured } }

    func observe(_ captured: UInt64, _ callback: @escaping @Sendable () -> Void) -> UUID? {
        let id = UUID()
        let installed = lock.withLock {
            guard enabled, epoch == captured else { return false }
            observers[id] = callback
            return true
        }
        if !installed { callback() }
        return installed ? id : nil
    }

    func remove(_ id: UUID?) {
        if let id { _ = lock.withLock { observers.removeValue(forKey: id) } }
    }
}

struct PrototypeLibraryGatedClient: PrototypeHttpClient {
    let gate: PrototypeLibraryNetworkGate
    let factory: @MainActor @Sendable () -> PrototypeNetworkConfiguration

    var onLocalNetworkDenied: @MainActor @Sendable () -> Void = {}

    static let disabled = PrototypeHttpFailure(
        error: .init(.blockedDestination, "Network is disabled for imported prototypes."), durationMs: 0
    )

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        do { return try await execute(request) }
        catch {
            if let failure = error as? PrototypeHttpFailure,
               failure.localNetworkDenied
            {
                // Revoke after leaving the race so this call retains its permission guidance.
                await onLocalNetworkDenied()
            }
            throw error
        }
    }

    @MainActor
    private func client(epoch: UInt64, call: PrototypePinnedCall) -> (any PrototypeHttpClient)? {
        guard call.active, gate.permits(epoch) else { return nil }
        return factory().device
    }

    private func execute(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        guard let epoch = gate.snapshot() else { throw Self.disabled }
        let call = PrototypePinnedCall()
        let observer = gate.observe(epoch) { call.finish(.failure(Self.disabled)) }
        defer { gate.remove(observer) }
        let outcome: Result<PrototypeHttpResponse, Error>
        do {
            outcome = try .success(await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    call.install(continuation)
                    let task = Task {
                        guard call.active, gate.permits(epoch) else { return }
                        guard let client = await client(epoch: epoch, call: call),
                              call.active, gate.permits(epoch) else { return }
                        let result: Result<PrototypeHttpResponse, Error>
                        do { result = try .success(await client.perform(request)) }
                        catch { result = .failure(error) }
                        call.finish(gate.permits(epoch) ? result : .failure(Self.disabled))
                    }
                    call.install(task: task)
                }
            } onCancel: {
                call.finish(.failure(PrototypeHttpFailure(
                    error: .init(.cancelled, "Request was cancelled."), durationMs: 0
                )))
            })
        } catch { outcome = .failure(error) }
        guard gate.permits(epoch) else { throw Self.disabled }
        return try outcome.get()
    }
}
