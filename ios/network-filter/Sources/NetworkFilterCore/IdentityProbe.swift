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
    /// Version 3 reports offline rules; version 4 also carries shaped configuration.
    public let rules: [NetworkRuleStatus]?
    /// Version 4 only: adapter activity, omitted when no adapter is attached.
    public let shapingActivity: ShapingActivity?
    public let flows: [ProbeFlow]
    public let limitations: [String]
}

/// Flow-identity diagnostics. Rules are applied by `NetworkRuleStore` and
/// `AppFlowPolicy`; this type only records and reports.
public final class IdentityProbe {
    /// Version 4 carries shaped rules; version 3 read-backs omit them.
    public static let version = 4
    public static let supportedVersions = [3, 4]
    /// No rule is active: every flow is allowed.
    public static let allowOnlyMode = "allow_only"
    /// At least one leased per-app offline rule is active.
    public static let appOfflineMode = "app_offline"
    public static let appShapedMode = "app_shaped"
    public static let appMixedMode = "app_mixed"
    public static let modes = [allowOnlyMode, appOfflineMode, appShapedMode, appMixedMode]

    public static func modes(for version: Int) -> [String] {
        version == 3 ? [allowOnlyMode, appOfflineMode] : modes
    }

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
        rules: [NetworkRuleStatus] = [],
        version: Int = IdentityProbe.version,
        shapingActivity: ShapingActivity? = nil
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
        let offline = rules.filter { $0.condition == .offline }
        let shapedCount = rules.count - offline.count
        let visible = version == 3 ? offline : rules
        let mode: String
        if visible.isEmpty { mode = Self.allowOnlyMode }
        else if shapedCount == 0 || version == 3 { mode = Self.appOfflineMode }
        else { mode = offline.isEmpty ? Self.appShapedMode : Self.appMixedMode }
        var limitations = Self.offlineLimitations
        if version == 3, shapedCount > 0 {
            limitations.append("Omitted \(shapedCount) shaped rule(s): contract version 3 supports only offline rules.")
        } else if version == 4 {
            limitations
                .append(
                    "Shaped rules are enforced on NEW flows of the attributed app only; established flows are not shaped."
                )
            limitations
                .append(
                    "Data-path NetworkExtension assumptions and all traffic effects are unverified until the signed run (#10263)."
                )
            limitations.append("No network effects have been verified against controlled traffic probes.")
        }
        return ProbeSnapshot(
            version: version,
            backend: "macos_network_extension",
            mode: mode,
            observedFlows: observedFlows,
            discardedFlows: discardedFlows,
            managedSimulators: managedSimulators,
            rules: visible,
            shapingActivity: version == 4 ? shapingActivity : nil,
            flows: flows,
            limitations: limitations
        )
    }

    private static let offlineLimitations = [
        "Simulator attribution methods are unverified on a signed run (#10263).",
        "Offline rules drop new socket flows of one attributed app; established connections continue " +
            "until they close, and unattributed or conflicting flows are always allowed.",
        "Flow history is attributed at read-back: a process that exited since its flow is reported " +
            "as unattributed. Offline verdicts are attributed when each flow arrives.",
        "New socket flows only; non-socket traffic is not filtered.",
        "Code metadata may be absent if a process exits before snapshot collection.",
        "The newest 128 flow identities are retained; no payloads or network addresses are collected.",
    ]
    private func identity(_ token: Data?) -> ProbeProcessIdentity? {
        token.map { ProbeProcessIdentity(auditToken: $0, code: resolver.resolve(auditToken: $0)) }
    }
}
