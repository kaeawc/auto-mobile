import Foundation

public enum AppFlowVerdict: Equatable {
    case allow
    /// Drop this new flow: it belongs to the rule the ticket names.
    case drop(NetworkRuleTicket)
}

/// Decides each new flow at the moment it arrives (#10264).
///
/// While no rule is active it allows immediately, with no process or Security
/// lookup. While a rule is active it attributes the flow with
/// `SimulatorFlowResolver`, limited to the simulators active rules name, and
/// drops it only when the flow is `attributed` to that simulator and its app's
/// code-signing identifier equals the rule's bundle identifier. Every other
/// outcome — unattributed, conflicting, a failed lookup, a different app —
/// fails open and allows the flow.
///
/// Attribution runs outside the store's lock, so the verdict is committed
/// against the ticket it was computed for: if the rule was reset, replaced or
/// expired meanwhile, the flow is re-checked once against the current rule and
/// otherwise allowed.
public final class AppFlowPolicy {
    public static let codeCacheCapacity = 512

    private let store: NetworkRuleStore
    private let resolver: SimulatorFlowResolver
    private let identities: ProbeIdentityResolver
    private let cacheLock = NSLock()
    /// Audit token → code identity. A token names one process generation (its
    /// pid version), so a reused pid can never return a cached identity.
    private var codeCache: [Data: ProbeCodeIdentity] = [:]
    private var codeCacheOrder: [Data] = []

    public init(store: NetworkRuleStore, processTable: ProcessTable, identityResolver: ProbeIdentityResolver) {
        self.store = store
        resolver = SimulatorFlowResolver(processTable: processTable)
        identities = identityResolver
    }

    public func verdict(sourceAppAuditToken: Data?, sourceProcessAuditToken: Data?) -> AppFlowVerdict {
        guard let snapshot = store.evaluationSnapshot() else { return .allow }
        let app = sourceAppAuditToken.flatMap { $0.count == 32 ? $0 : nil }
        let process = sourceProcessAuditToken.flatMap { $0.count == 32 ? $0 : nil }
        guard app != nil || process != nil else { return .allow }
        let attribution = resolver.resolve(
            sourceApp: app.map(identity),
            sourceProcess: process.map(identity),
            managed: snapshot.managedSimulators
        )
        guard attribution.attribution == .attributed,
              let simulator = attribution.simulator,
              let bundleId = attribution.app?.bundleId,
              let managed = ManagedSimulator(deviceSet: simulator.deviceSet, udid: simulator.udid),
              let target = NetworkRuleTarget(simulator: managed, bundleId: bundleId),
              let ticket = snapshot.tickets[target]
        else { return .allow }
        if store.commitDrop(ticket) { return .drop(ticket) }
        // The rule changed while the flow was being attributed. Attribution does
        // not depend on the rule's revision, so re-check the target once.
        guard let current = store.currentTicket(for: target), store.commitDrop(current) else { return .allow }
        return .drop(current)
    }

    private func identity(_ token: Data) -> ProbeProcessIdentity {
        ProbeProcessIdentity(auditToken: token, code: code(for: token))
    }

    private func code(for token: Data) -> ProbeCodeIdentity? {
        cacheLock.lock()
        if let cached = codeCache[token] {
            cacheLock.unlock()
            return cached
        }
        cacheLock.unlock()
        // A failed lookup is not cached: the flow fails open and the next flow retries.
        guard let resolved = identities.resolve(auditToken: token) else { return nil }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if codeCache.updateValue(resolved, forKey: token) == nil {
            codeCacheOrder.append(token)
        }
        while codeCacheOrder.count > Self.codeCacheCapacity {
            codeCache.removeValue(forKey: codeCacheOrder.removeFirst())
        }
        return resolved
    }
}
