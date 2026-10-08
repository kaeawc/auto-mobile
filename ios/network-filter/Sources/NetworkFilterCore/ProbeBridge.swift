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

    /// `command` is a JSON `NetworkRuleCommand`; the reply is a JSON `NetworkRuleResult`.
    func rule(version: Int, command: Data, reply: @escaping (Data?, String?) -> Void)
}

public final class ProbeService: NSObject, ProbeBridge {
    private let probe: IdentityProbe
    private let rules: NetworkRuleStore
    private let lock = NSLock()
    private var active = false
    private var generation: UInt64 = 0

    public init(probe: IdentityProbe, rules: NetworkRuleStore) {
        self.probe = probe
        self.rules = rules
    }

    @discardableResult
    public func stopOrBeginStartup() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        active = false
        generation &+= 1
        // A stopped or restarting filter must not resurrect an impairment the
        // host may have stopped renewing: every rule ends here.
        rules.removeAll()
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
            let data = try JSONEncoder().encode(
                probe.snapshot(managedSimulators: simulators, rules: rules.activeRules())
            )
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

    public func rule(version: Int, command: Data, reply: @escaping (Data?, String?) -> Void) {
        guard version == IdentityProbe.version else {
            reply(nil, "Unsupported identity-probe protocol version")
            return
        }
        guard let decoded = try? JSONDecoder().decode(NetworkRuleCommand.self, from: command) else {
            reply(nil, "Invalid network rule command")
            return
        }
        lock.lock()
        let started = active
        lock.unlock()
        // An inactive provider applies nothing, so its answer is definitive: the
        // controller retries this startup state like a read-back.
        guard started else {
            reply(nil, ProbeReadbackStartupState.inactiveProviderMessage)
            return
        }
        guard let data = try? JSONEncoder().encode(rules.execute(decoded)) else {
            reply(nil, "Unable to encode network rule result")
            return
        }
        reply(data, nil)
    }
}
