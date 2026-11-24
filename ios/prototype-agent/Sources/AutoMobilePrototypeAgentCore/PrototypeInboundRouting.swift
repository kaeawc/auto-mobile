import Foundation

/// Adapts validated inbound entries to the existing matcher and tap action decoder.
struct PrototypeInboundRouting {
    let entries: [JSONValue]
    private static let bindingMaps: Set<String> = ["params", "context", "args", "headers", "query", "form"]

    func resolve(_ url: String, schemes: [String]) -> PrototypeLinkMatcher.Match? {
        PrototypeLinkResolver.resolve(url, registration: .init(schemes: schemes), entries: entries.map { entry in
            let fields = entry.objectFields ?? [:]
            return .init(
                path: fields["path"]?.stringValue ?? "",
                query: (fields["query"]?.objectFields ?? [:])
                    .mapValues { $0.stringValue ?? $0.objectFields?["type"]?.stringValue ?? "" }
            )
        })
    }

    func path(_ match: PrototypeLinkMatcher.Match) -> String {
        entries[match.entryIndex].objectFields?["path"]?.stringValue ?? ""
    }

    private enum Refusal: Error { case absentBinding }

    func actions(_ match: PrototypeLinkMatcher.Match) throws -> [PrototypeAction] {
        let values = match.query.merging(match.captures.mapValues(JSONValue.string)) { _, capture in capture }
        let raw = entries[match.entryIndex].objectFields?["actions"] ?? .array([])
        let bound = try bind(raw, values: values)
        return try JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(bound))
    }

    private func bind(_ raw: JSONValue, values: [String: JSONValue]) throws -> JSONValue {
        if case let .array(items) = raw { return try .array(items.map { try bind($0, values: values) }) }
        guard var fields = raw.objectFields else { return raw }
        if fields.count == 1, let name = fields["link"]?.stringValue {
            guard let value = values[name] else { throw Refusal.absentBinding }
            return .object(["value": value])
        }
        // Literal payloads and {value: ...} objects are opaque, including literal objects named link.
        if fields.count == 1, fields["value"] != nil { return raw }
        for (key, child) in fields where key != "payload" {
            if Self.bindingMaps.contains(key), let map = child.objectFields {
                fields[key] = try .object(map.mapValues { try bind($0, values: values) })
            } else {
                fields[key] = try bind(child, values: values)
            }
        }
        if fields["type"] == .string("setState"), let literal = fields["value"]?.objectFields?["value"] {
            fields["value"] = literal
        }
        return .object(fields)
    }

    /// Remove every occurrence of every declared secret, including encoded query names on unmatched URLs.
    func redact(_ url: String) -> String {
        let secrets = Set(entries.flatMap { entry in
            (entry.objectFields?["query"]?.objectFields ?? [:]).compactMap { name, declaration in
                declaration.objectFields?["secret"] == .bool(true) ? name : nil
            }
        })
        guard !secrets.isEmpty else { return url }
        let parts = url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        let head = String(parts[0])
        guard let separator = head.firstIndex(of: "?") else { return url }
        let query = head[head.index(after: separator)...].split(separator: "&", omittingEmptySubsequences: false)
            .filter { pair in
                let encoded = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0]
                guard let name = encoded.replacingOccurrences(of: "+", with: " ").removingPercentEncoding else {
                    return false
                }
                return !secrets.contains(name)
            }.joined(separator: "&")
        let fragment = parts.count == 2 ? "#" + parts[1] : ""
        return String(head[..<separator]) + (query.isEmpty ? "" : "?" + query) + fragment
    }
}
