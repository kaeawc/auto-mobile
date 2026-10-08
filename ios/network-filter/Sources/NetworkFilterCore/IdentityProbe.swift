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
    public let flows: [ProbeFlow]
    public let limitations: [String]
}

/// Diagnostics only. This type has no rule application or blocking operation.
public final class IdentityProbe {
    public static let version = 2
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
    public func snapshot(managedSimulators: [ManagedSimulator] = []) -> ProbeSnapshot {
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
            mode: "allow_only",
            observedFlows: observedFlows,
            discardedFlows: discardedFlows,
            managedSimulators: managedSimulators,
            flows: flows,
            limitations: [
                "Simulator attribution methods are unverified on a signed run (#10263); no network condition is applied.",
                "Attribution is resolved at read-back: a process that exited since its flow is reported as unattributed.",
                "New socket flows only; existing connections and non-socket traffic are not measured.",
                "Code metadata may be absent if a process exits before snapshot collection.",
                "The newest 128 flow identities are retained; no payloads or network addresses are collected.",
            ]
        )
    }

    private func identity(_ token: Data?) -> ProbeProcessIdentity? {
        token.map { ProbeProcessIdentity(auditToken: $0, code: resolver.resolve(auditToken: $0)) }
    }
}
