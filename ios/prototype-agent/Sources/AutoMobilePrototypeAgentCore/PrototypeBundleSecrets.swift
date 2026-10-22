import Foundation

struct PrototypeBundleSecretWarning: Equatable {
    enum Code: String {
        case credentialHeader = "credential_header", credentialQuery = "credential_query", privateHost = "private_host"
    }

    let code: Code
    let path: String
}

enum PrototypeBundleSecrets {
    /// Advisory only: paths contain field names, never credential values, and no DNS is performed.
    static func scan(_ spec: Data) -> [PrototypeBundleSecretWarning] {
        guard spec.count <= PrototypeBundle.maxSpecBytes,
              let json = try? PrototypeBundleJSON(spec, code: .specInvalidJSON, path: "spec.json") else { return [] }
        var pending: [(JSONValue, String)] = [(json.value, "$")]
        var warnings: [PrototypeBundleSecretWarning] = []
        while let (value, path) = pending.popLast() {
            if let fields = value.objectFields {
                if fields["type"]?.stringValue == "request" {
                    let headerPath = "\(path).headers"
                    for name in json.objectKeys[headerPath] ?? [] where
                        ["authorization", "cookie", "x-api-key"].contains(name.lowercased())
                    {
                        warnings.append(.init(code: .credentialHeader, path: "\(headerPath).\(name)"))
                    }
                    if let url = fields["url"]?.stringValue { warnings += urlWarnings(url, path: "\(path).url") }
                }
                for key in json.objectKeys[path] ?? [] {
                    if let child = fields[key] { pending.append((child, "\(path).\(key)")) }
                }
            } else if case let .array(items) = value {
                pending += items.enumerated().map { ($0.element, "\(path).\($0.offset)") }
            }
        }
        return warnings
    }

    private static func urlWarnings(_ text: String, path: String) -> [PrototypeBundleSecretWarning] {
        guard let url = URLComponents(string: text), url.scheme != nil,
              url.port.map({ (0 ... 65535).contains($0) }) ?? true else { return [] }
        var warnings: [PrototypeBundleSecretWarning] = []
        for query in url.queryItems ?? [] where ["token", "key", "secret", "sig"].contains(query.name.lowercased()) {
            warnings.append(.init(code: .credentialQuery, path: "\(path).query.\(query.name)"))
        }
        var host = (url.host ?? "").lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        let literal = PrototypeEgressPolicy.canonicalLiteral(host)
        if host == "localhost" || host.hasSuffix(".localhost") ||
            literal.map({ PrototypeEgressPolicy.classify($0) != .public }) == true
        {
            warnings.append(.init(code: .privateHost, path: path))
        }
        return warnings
    }
}
