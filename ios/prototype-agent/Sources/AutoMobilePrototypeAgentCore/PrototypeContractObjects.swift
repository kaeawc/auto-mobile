import Foundation

extension PrototypeContractValidator {
    mutating func object(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard let data = value.objectFields, let fields = rule["fields"]?.objectFields else {
            throw Self.invalid(path, "Expected object")
        }
        if rule == definitions["node"]?.objectFields?["variants"]?.objectFields?["text"]?.objectFields {
            let spans = data["spans"] != nil
            if (data["text"] != nil) == spans {
                throw Self.invalid(
                    Self.keyPath(path, spans ? "spans" : "text"),
                    spans ? "text and spans cannot both be set" : "text node needs text or spans"
                )
            }
            if case let .array(items)? = data["spans"], items.count > PrototypeLimits.maxTextSpans {
                throw Self.invalid(Self.keyPath(path, "spans"), "Text span limit exceeded")
            }
        }
        if data["type"] == .string("searchBar"), data["child"] != nil, data["activeKey"] == nil {
            throw Self.invalid("\(path).child", "Search bar child requires activeKey")
        }
        if data["empty"] != nil, data["key"] != nil || data["platform"] != nil {
            throw Self.invalid("\(path).empty", "empty applies only to data conditions")
        }
        for key in Self.sorted(Set(data.keys).union(fields.keys)) {
            let childPath = Self.keyPath(path, key)
            guard let field = fields[key]?.objectFields, let childRule = field["rule"] else {
                throw Self.invalid(childPath, "Unknown property")
            }
            if let child = data[key] { try walk(child, rule: childRule, path: childPath, depth: depth) }
            else if field["optional"] != .bool(true) { throw Self.invalid(childPath, "Required property") }
        }
        let kind = ["style", "fadeEdges", "imageFilter"].first { rule == definitions[$0]?.objectFields } ?? ""
        try PrototypeStylePolishV2.validateObject(data, kind: kind, path: path)
        try Self.constraints(data, rule: rule, path: path)
    }

    private static func constraints(_ data: [String: JSONValue], rule: [String: JSONValue], path: String) throws {
        if rule["binding"] == .bool(true), (data["pager"] != nil) == (data["stateKey"] != nil) {
            throw invalid(keyPath(path, "pager"), "Exactly one of pager or stateKey is required")
        }
        let exclusive = strings(rule["exclusive"])
        if let first = exclusive.first, exclusive.filter({ data[$0] != nil }).count != 1 {
            throw invalid(keyPath(path, first), "Exactly one container selector is required")
        }
        let exactlyOne = strings(rule["exactlyOne"])
        if let first = exactlyOne.first, exactlyOne.filter({ data[$0] != nil }).count != 1 {
            throw invalid(keyPath(path, first), "Exactly one of \(exactlyOne.joined(separator: ", ")) is required")
        }
        for trigger in sorted(rule["dependents"]?.objectFields?.keys ?? [String: JSONValue]().keys) {
            let names = strings(rule["dependents"]?.objectFields?[trigger])
            let present = names.filter { data[$0] != nil }
            let triggers = trigger.split(separator: "|").map(String.init)
            if !triggers.contains(where: { data[$0] != nil }) {
                if let first = present.first {
                    throw invalid(keyPath(path, first), "Requires \(triggers.joined(separator: " or "))")
                }
            } else if trigger.contains("|"), present.count != 1, let first = names.first {
                throw invalid(
                    keyPath(path, present.dropFirst().first ?? first),
                    "Exactly one of \(names.joined(separator: ", ")) is required"
                )
            }
        }
        if rule["atLeastOne"] == .bool(true), data.isEmpty {
            throw invalid(
                path,
                path
                    .hasSuffix(".semantics") ? "Expected at least one semantics field" :
                    "At least one selector field is required"
            )
        }
    }

    static func strings(_ value: JSONValue?) -> [String] {
        guard case let .array(items)? = value else { return [] }
        return items.compactMap(\.stringValue)
    }
}
