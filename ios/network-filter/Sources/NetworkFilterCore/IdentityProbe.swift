import Foundation

public struct ProbeCodeIdentity: Codable, Equatable {
    public let signingIdentifier: String?
    public let teamIdentifier: String?
    public let executablePath: String?

    public init(signingIdentifier: String?, teamIdentifier: String?, executablePath: String?) {
        self.signingIdentifier = signingIdentifier
        self.teamIdentifier = teamIdentifier
        self.executablePath = executablePath
    }
}

public protocol ProbeIdentityResolver {
    func resolve(auditToken: Data) -> ProbeCodeIdentity?
}

public struct ProbeProcessIdentity: Codable, Equatable {
    // Preserve the complete audit token, including process generation. A PID
    // or bundle identifier alone is never sufficient evidence for targeting.
    public let auditToken: Data
    public let code: ProbeCodeIdentity?
}

public struct ProbeFlow: Codable, Equatable {
    public let sourceApp: ProbeProcessIdentity?
    public let sourceProcess: ProbeProcessIdentity?
    public let delegated: Bool?
    // Version 2 fields. They are optional so a version 1 snapshot still decodes.
    public let attribution: FlowAttributionStatus?
    public let method: SimulatorAttributionMethod?
    public let simulator: FlowSimulator?
    public let app: FlowApp?
    public let reason: FlowAttributionReason?

    public init(
        sourceApp: ProbeProcessIdentity?,
        sourceProcess: ProbeProcessIdentity?,
        delegated: Bool?,
        attribution: FlowAttribution? = nil
    ) {
        self.sourceApp = sourceApp
        self.sourceProcess = sourceProcess
        self.delegated = delegated
        self.attribution = attribution?.attribution
        method = attribution?.method
        simulator = attribution?.simulator
        app = attribution?.app
        reason = attribution?.reason
    }
}

public struct ProbeSnapshot: Codable {
    public let version: Int
    public let backend: String
    public let mode: String
    public let observedFlows: UInt64
    public let discardedFlows: UInt64
    /// Version 2: the simulators the host allowed attribution to for this read-back.
    public let managedSimulators: [ManagedSimulator]?
    /// Version 3: the leased rules the provider enforces right now (#10264).
    public let rules: [NetworkRuleStatus]?
    public let flows: [ProbeFlow]
    public let limitations: [String]
}

/// Flow-identity diagnostics. Rules are applied by `NetworkRuleStore` and
/// `AppFlowPolicy`; this type only records and reports.
public final class IdentityProbe {
    /// Version 3 adds `rules` and the `app_offline` mode (#10264).
    public static let version = 3
    /// No rule is active: every flow is allowed.
    public static let allowOnlyMode = "allow_only"
    /// At least one leased per-app offline rule is active.
    public static let appOfflineMode = "app_offline"
    public static let modes = [allowOnlyMode, appOfflineMode]
    public static let capacity = 128
    private let resolver: ProbeIdentityResolver
    private let attributionResolver: SimulatorFlowResolver
    private let lock = NSLock()
    private var tokens: [(Data?, Data?)] = []
    private var observed: UInt64 = 0
    private var discarded: UInt64 = 0

    public init(resolver: ProbeIdentityResolver, processTable: ProcessTable) {
        self.resolver = resolver
        attributionResolver = SimulatorFlowResolver(processTable: processTable)
    }

    public func record(sourceAppAuditToken: Data?, sourceProcessAuditToken: Data?) {
        // audit_token_t contains eight UInt32 fields. Never parse a PID out of
        // it or perform Security lookups on the allow-new-flow critical path.
        let app = sourceAppAuditToken.flatMap { $0.count == 32 ? $0 : nil }
        let process = sourceProcessAuditToken.flatMap { $0.count == 32 ? $0 : nil }
        lock.lock()
        defer { lock.unlock() }
        observed &+= 1
        if tokens.count == Self.capacity {
            tokens.removeFirst()
            discarded &+= 1
        }
        tokens.append((app, process))
    }

    /// Resolves identities and simulator attribution at read-back time, off the
    /// flow callback. Only `managedSimulators` can be attributed; every other flow,
    /// and every failed lookup, is reported as unattributed.
    public func snapshot(
        managedSimulators: [ManagedSimulator] = [],
        rules: [NetworkRuleStatus] = []
    )
        -> ProbeSnapshot
    {
        lock.lock()
        let retained = tokens
        let observedFlows = observed
        let discardedFlows = discarded
        lock.unlock()
        let managed = Set(managedSimulators)
        let flows = retained.map { app, process in
            let sourceApp = identity(app)
            let sourceProcess = identity(process)
            return ProbeFlow(
                sourceApp: sourceApp,
                sourceProcess: sourceProcess,
                delegated: app.flatMap { source in process.map { source != $0 } },
                attribution: attributionResolver.resolve(
                    sourceApp: sourceApp,
                    sourceProcess: sourceProcess,
                    managed: managed
                )
            )
        }
        return ProbeSnapshot(
            version: Self.version,
            backend: "macos_network_extension",
            mode: rules.isEmpty ? Self.allowOnlyMode : Self.appOfflineMode,
            observedFlows: observedFlows,
            discardedFlows: discardedFlows,
            managedSimulators: managedSimulators,
            rules: rules,
            flows: flows,
            limitations: [
                "Simulator attribution methods are unverified on a signed run (#10263).",
                "Offline rules drop new socket flows of one attributed app; established connections continue " +
                    "until they close, and unattributed or conflicting flows are always allowed.",
                "Flow history is attributed at read-back: a process that exited since its flow is reported " +
                    "as unattributed. Offline verdicts are attributed when each flow arrives.",
                "New socket flows only; non-socket traffic is not filtered.",
                "Code metadata may be absent if a process exits before snapshot collection.",
                "The newest 128 flow identities are retained; no payloads or network addresses are collected.",
            ]
        )
    }

    private func identity(_ token: Data?) -> ProbeProcessIdentity? {
        token.map { ProbeProcessIdentity(auditToken: $0, code: resolver.resolve(auditToken: $0)) }
    }
}
