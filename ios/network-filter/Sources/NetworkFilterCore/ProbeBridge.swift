import Foundation

public enum ProbeReadbackStartupState {
    public static let inactiveProviderMessage = "Identity-probe provider is not active"

    /// A provider can expose its XPC listener before `apply` completes. This is
    /// the only response that means its authenticated readback should be
    /// retried during controller startup; protocol and signing failures remain
    /// terminal.
    public static func isTransient(_ error: String?) -> Bool {
        error == inactiveProviderMessage
    }
}

@objc
public protocol ProbeBridge {
    /// `managedSimulators` is a JSON array of `ManagedSimulator`: the only
    /// simulators the provider may attribute flows to.
    func snapshot(version: Int, managedSimulators: Data, reply: @escaping (Data?, String?) -> Void)
}

public final class ProbeService: NSObject, ProbeBridge {
    private let probe: IdentityProbe
    private let lock = NSLock()
    private var active = false
    private var generation: UInt64 = 0

    public init(probe: IdentityProbe) {
        self.probe = probe
    }

    @discardableResult
    public func stopOrBeginStartup() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        active = false
        generation &+= 1
        return generation
    }

    public func finishStartup(generation expected: UInt64, succeeded: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard generation == expected else { return false }
        active = succeeded
        return true
    }

    public func snapshot(version: Int, managedSimulators: Data, reply: @escaping (Data?, String?) -> Void) {
        guard version == IdentityProbe.version else {
            reply(nil, "Unsupported identity-probe protocol version")
            return
        }
        guard let simulators = try? JSONDecoder().decode([ManagedSimulator].self, from: managedSimulators),
              simulators.count <= ManagedSimulator.maximumCount
        else {
            reply(nil, "Invalid managed simulator configuration")
            return
        }
        lock.lock()
        let started = active
        let revision = generation
        lock.unlock()
        guard started else {
            reply(nil, ProbeReadbackStartupState.inactiveProviderMessage)
            return
        }
        do {
            let data = try JSONEncoder().encode(probe.snapshot(managedSimulators: simulators))
            lock.lock()
            let current = active && revision == generation
            lock.unlock()
            guard current else {
                reply(nil, "Identity-probe provider changed while collecting the snapshot")
                return
            }
            reply(data, nil)
        } catch {
            reply(nil, "Unable to encode identity-probe snapshot")
        }
    }
}
