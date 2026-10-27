import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// PrototypePinnedHttpClient is the enforcing transport: it resolves once and dials a checked IP.
/// URLSession performs its own DNS lookup after this preflight, so these answers do not pin its
/// connection. Remote-address metrics cannot prevent a connection or undo a transmitted request.
/// Its network-load metrics must include a remote address; proxy connections are refused.
struct PrototypeRequestEgressCheck: Sendable {
    let policy: PrototypeEgressPolicy
    let resolver: any HostResolving

    static let blocked = PrototypeRequestError(.blockedDestination, "Blocked destination by egress policy.")

    func validate(_ request: URLRequest) async throws {
        if let problem = PrototypeHttpHeaderCheck.problem(in: request.allHTTPHeaderFields ?? [:]) { throw problem }
        guard let url = request.url, let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host,
              policy.checkHost(host: host, port: Self.port(url)) == .allow else { throw Self.blocked }
        if PrototypeEgressPolicy.isIPLiteral(host) { return }
        let addresses = try await resolver.addresses(for: host)
        guard !addresses.isEmpty,
              policy.check(host: host, port: Self.port(url), addresses: addresses) == .allow else { throw Self.blocked }
    }

    func checkConnected(address: String, url: URL, port: Int? = nil) -> Bool {
        policy.check(host: address, port: port ?? Self.port(url), addresses: [address]) == .allow
    }

    static func port(_ url: URL) -> Int { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
            lhs.host?.lowercased() == rhs.host?.lowercased() && port(lhs) == port(rhs)
    }
}
