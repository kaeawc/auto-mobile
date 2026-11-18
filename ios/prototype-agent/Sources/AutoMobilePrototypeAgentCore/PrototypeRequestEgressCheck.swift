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

    /// Nil preserves request policy; only image loads may opt into development loopback.
    var remoteImageDevelopment: Bool?

    func isImageLoopback(_ url: URL) -> Bool {
        remoteImageDevelopment == true && url.scheme?.lowercased() == "http" &&
            ["localhost", "127.0.0.1", "[::1]", "::1"].contains(url.host?.lowercased() ?? "")
    }

    func validateImageURL(_ text: String) throws {
        guard !text.contains("{"), !text.contains("}"), text.utf16.count <= PrototypeRemoteImages.maxURLLength else {
            throw Self.blocked
        }
        try PrototypeRemoteImages.validate(nodes: [.init(value: [
            "type": .string("image"), "url": .string(text),
        ], path: "image")], state: [:])
        guard let url = URL(string: text), url.scheme?.lowercased() == "https" || isImageLoopback(url) else {
            throw Self.blocked
        }
        guard let host = url.host, (1 ... 65535).contains(Self.port(url)) else { throw Self.blocked }
        if !isImageLoopback(url) {
            guard policy.checkHost(host: host, port: Self.port(url)) == .allow,
                  !PrototypeEgressPolicy.isIPLiteral(host) || isPublic(host) else { throw Self.blocked }
        }
    }

    private func isPublic(_ address: String) -> Bool {
        guard let literal = PrototypeEgressPolicy.canonicalLiteral(address) else { return false }
        return PrototypeEgressPolicy.classify(literal) == .public
    }

    static let blocked = PrototypeRequestError(.blockedDestination, "Blocked destination by egress policy.")

    func validate(_ request: URLRequest) async throws {
        if let problem = PrototypeHttpHeaderCheck.problem(in: request.allHTTPHeaderFields ?? [:]) { throw problem }
        if remoteImageDevelopment != nil {
            try validateImageURL(request.url?.absoluteString ?? "")
            if let url = request.url, isImageLoopback(url) {
                let addresses = url.host?.lowercased() == "localhost" ? try await resolver
                    .addresses(for: "localhost") : [url.host ?? ""]
                guard !addresses.isEmpty, addresses.allSatisfy({
                    ["127.0.0.1", "::1"].contains(PrototypeEgressPolicy.canonicalLiteral($0) ?? "")
                }) else { throw Self.blocked }
                return
            }
        }
        guard let url = request.url, let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host,
              policy.checkHost(host: host, port: Self.port(url)) == .allow else { throw Self.blocked }
        if PrototypeEgressPolicy.isIPLiteral(host) {
            if remoteImageDevelopment != nil, !isPublic(host) { throw Self.blocked }
            return
        }
        let addresses = try await resolver.addresses(for: host)
        guard !addresses.isEmpty,
              policy.check(host: host, port: Self.port(url), addresses: addresses) == .allow,
              remoteImageDevelopment == nil || addresses.allSatisfy(isPublic) else { throw Self.blocked }
    }

    func checkConnected(address: String, url: URL, port: Int? = nil) -> Bool {
        if isImageLoopback(url) {
            return ["127.0.0.1", "::1"].contains(PrototypeEgressPolicy.canonicalLiteral(address) ?? "")
        }
        return (remoteImageDevelopment == nil || isPublic(address)) &&
            policy.check(host: address, port: port ?? Self.port(url), addresses: [address]) == .allow
    }

    static func port(_ url: URL) -> Int { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }

    static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
            lhs.host?.lowercased() == rhs.host?.lowercased() && port(lhs) == port(rhs)
    }
}
