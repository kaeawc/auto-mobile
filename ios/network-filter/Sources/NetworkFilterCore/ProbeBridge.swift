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

/// Lock order: service lock → coordinator lock → shaper lock → store lock.
/// Stop holds the service lock through onStop, making rule removal and pause
/// settlement atomic with commands/startup. The coordinator never calls the
/// service; onRulesChanged and shapingActivity run outside the service lock.
public final class ProbeService: NSObject, ProbeBridge {
    private let probe: IdentityProbe
    private let rules: NetworkRuleStore
    // Internal so lifecycle tests can pin the lock held across the stop hook.
    let lock = NSLock()
    private var active = false
    private var generation: UInt64 = 0
    private let onRulesChanged: (() -> Void)?
    private let onStop: (() -> Void)?
    private let shapingActivity: (() -> ShapingActivity?)?

    public init(
        probe: IdentityProbe, rules: NetworkRuleStore,
        onRulesChanged: (() -> Void)? = nil, onStop: (() -> Void)? = nil,
        shapingActivity: (() -> ShapingActivity?)? = nil
    ) {
        self.probe = probe
        self.rules = rules
        self.onRulesChanged = onRulesChanged
        self.onStop = onStop
        self.shapingActivity = shapingActivity
    }

    @discardableResult
    public func stopOrBeginStartup() -> UInt64 {
        lock.lock()
        active = false
        generation &+= 1
        // A stopped or restarting filter must not resurrect an impairment the
        // host may have stopped renewing: every rule ends here.
        rules.removeAll()
        onStop?()
        let current = generation
        lock.unlock()
        return current
    }

    public func finishStartup(generation expected: UInt64, succeeded: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard generation == expected else { return false }
        active = succeeded
        return true
    }

    public func snapshot(version: Int, managedSimulators: Data, reply: @escaping (Data?, String?) -> Void) {
        guard IdentityProbe.supportedVersions.contains(version) else {
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
                probe.snapshot(
                    managedSimulators: simulators, rules: rules.activeRules(), version: version,
                    shapingActivity: version == 4 ? shapingActivity?() : nil
                )
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
        guard IdentityProbe.supportedVersions.contains(version) else {
            reply(nil, "Unsupported identity-probe protocol version")
            return
        }
        guard let decoded = try? JSONDecoder().decode(NetworkRuleCommand.self, from: command) else {
            reply(nil, "Invalid network rule command")
            return
        }
        lock.lock()
        let started = active
        // An inactive provider applies nothing, so its answer is definitive: the
        // controller retries this startup state like a read-back.
        guard started else {
            lock.unlock()
            reply(nil, ProbeReadbackStartupState.inactiveProviderMessage)
            return
        }
        let result: NetworkRuleResult
        if version == 3, let condition = decoded.condition, condition != .offline {
            result = NetworkRuleResult(outcome: .invalidCommand)
            lock.unlock()
        } else {
            result = rules.execute(decoded)
            lock.unlock()
            onRulesChanged?()
        }
        guard let data = try? JSONEncoder().encode(result) else {
            reply(nil, "Unable to encode network rule result")
            return
        }
        reply(data, nil)
    }
}
