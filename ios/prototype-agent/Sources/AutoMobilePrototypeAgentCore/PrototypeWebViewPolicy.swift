import Foundation

enum PrototypeWebViewPolicy {
    enum Decision: Equatable {
        case allow
        case block(String)
    }

    // The checks are identical for main frames, subframes and redirects.
    static func check(
        _ url: String, allowedOrigins: [String], daemonPorts: Set<Int> = []
    )
        -> Decision
    {
        guard URL(string: url, encodingInvalidCharacters: false) != nil,
              let components = URLComponents(string: url)
        else { return .block("Malformed URL") }
        guard components.scheme == "https", url.hasPrefix("https://") else { return .block("HTTPS is required") }
        guard components.user == nil, components.password == nil else { return .block("URL credentials are forbidden") }
        guard let host = components.host?.lowercased(), !host.isEmpty else { return .block("A DNS host is required") }

        let normalized = host.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if let literal = PrototypeEgressPolicy.canonicalLiteral(normalized),
           PrototypeEgressPolicy.classify(literal) != .public
        { return .block("Private host") }
        guard !host.contains(":"), !PrototypeWebView.isPrivateHost(normalized) else {
            return .block("Private or numeric host")
        }

        let egress = PrototypeEgressPolicy()
        let port = components.port ?? 443
        guard !egress.daemonPorts.contains(port), !daemonPorts.contains(port) else { return .block("Daemon port") }
        guard (1 ... 65535).contains(port) else { return .block("Invalid port") }
        guard egress.checkHost(host: host, port: port) == .allow else { return .block("A DNS host is required") }

        // Compare the original authority to refuse escaped hosts, empty ports and zero-padded ports.
        let authority = url.unicodeScalars.dropFirst("https://".count).prefix { !"/?#".unicodeScalars.contains($0) }
        let expected = host + (components.port.map { ":\($0)" } ?? "")
        guard String(authority).lowercased() == expected else { return .block("Malformed authority") }
        let origin = "https://" + host + (port == 443 ? "" : ":\(port)")
        return allowedOrigins.contains(origin) ? .allow : .block("Origin is outside allowedOrigins")
    }

    static func contentRules(allowedOrigins: [String]) throws -> String {
        func rule(_ type: String, _ filter: String) -> [String: [String: String]] {
            ["action": ["type": type], "trigger": ["url-filter": filter]]
        }

        var rules = [rule("block", ".*")]
        for origin in allowedOrigins where check(origin, allowedOrigins: [origin]) == .allow {
            // Policy only accepts literal DNS authorities here. Use WebKit's basic URL-filter
            // syntax and require the authority to end at a URL delimiter or end of input.
            let prefix = "^" + origin.replacingOccurrences(of: ".", with: "[.]")
            let prefixes = URLComponents(string: origin)?.port == nil ? [prefix, prefix + ":443"] : [prefix]
            for prefix in prefixes {
                rules.append(rule("ignore-previous-rules", prefix + "$"))
                rules.append(rule("ignore-previous-rules", prefix + "[/?#]"))
            }
        }
        guard let json = try String(data: JSONEncoder().encode(rules), encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        return json
    }
}
