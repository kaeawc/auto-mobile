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
}

public struct ProbeSnapshot: Codable {
    public let version: Int
    public let backend: String
    public let mode: String
    public let observedFlows: UInt64
    public let discardedFlows: UInt64
    public let flows: [ProbeFlow]
    public let limitations: [String]
}

/// Diagnostics only. This type has no rule application or blocking operation.
public final class IdentityProbe {
    public static let version = 1
    public static let capacity = 128
    private let resolver: ProbeIdentityResolver
    private let lock = NSLock()
    private var tokens: [(Data?, Data?)] = []
    private var observed: UInt64 = 0
    private var discarded: UInt64 = 0

    public init(resolver: ProbeIdentityResolver) {
        self.resolver = resolver
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

    public func snapshot() -> ProbeSnapshot {
        lock.lock()
        let retained = tokens
        let observedFlows = observed
        let discardedFlows = discarded
        lock.unlock()
        let flows = retained.map { app, process in
            ProbeFlow(
                sourceApp: identity(app),
                sourceProcess: identity(process),
                delegated: app.flatMap { source in process.map { source != $0 } }
            )
        }
        return ProbeSnapshot(
            version: Self.version,
            backend: "macos_network_extension",
            mode: "allow_only",
            observedFlows: observedFlows,
            discardedFlows: discardedFlows,
            flows: flows,
            limitations: [
                "Simulator attribution is unverified; no network condition is applied.",
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
