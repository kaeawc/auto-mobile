import Foundation

/// Shared keys are checked after structure, before ordinary repeat semantics.
enum PrototypeSharedElementRules {
    private struct Occurrence {
        let path: String
        let at: String
        let boundary: String
        let kind: String
        let templated: Bool
        let repeatPath: String?
    }

    static func validate(
        _ nodes: [PrototypeLocatedValue],
        data: [String: JSONValue]?,
        actions: [PrototypeLocatedValue] = []
    )
        throws
    {
        let sources = try PrototypeStackPatterns.sources(nodes, actions: actions)
        var pairs: [String: [Occurrence]] = [:]
        var order: [String] = []
        for node in nodes {
            let shared = node.value["shared"]?.objectFields
            guard let key = shared?["key"]?.stringValue ?? node.value["sharedKey"]?.stringValue else { continue }
            let at = "\(node.path).\(shared == nil ? "sharedKey" : "shared.key")"
            if shared != nil, node.value["sharedKey"] != nil {
                throw PrototypeContractValidator.invalid(
                    "\(node.path).shared",
                    "shared and sharedKey cannot both be set"
                )
            }
            let source = sources.contains(key)
            guard node.value["visibleWhen"] != nil || source else {
                throw PrototypeContractValidator.invalid(at, "sharedKey requires visibleWhen on the same node")
            }
            let parent = nodes.last { $0.value["repeat"] != nil &&
                (node.path == $0.path || node.path.hasPrefix("\($0.path)."))
            }
            let keys = try resolvedKeys(key, shared: shared != nil, parent: parent, path: node.path, at: at, data: data)
            if source { continue }
            let boundary = nodes.filter {
                ["dialog", "bottomSheet"].contains($0.value["type"]?.stringValue ?? "") &&
                    (node.path == $0.path || node.path.hasPrefix("\($0.path)."))
            }.map(\.path).joined(separator: "/")
            let entry = Occurrence(
                path: node.path,
                at: at,
                boundary: boundary,
                kind: shared?["as"]?.stringValue ?? "bounds",
                templated: key.contains("{"),
                repeatPath: parent?.path == node.path ? nil : parent?.path
            )
            for resolved in keys {
                if pairs[resolved] == nil { pairs[resolved] = []; order.append(resolved) }
                try checkPair(resolved, entry: entry, prior: pairs[resolved] ?? [], count: pairs.count)
                pairs[resolved, default: []].append(entry)
            }
        }
        for key in order {
            if let entries = pairs[key], entries.count != 2, let first = entries.first, !first.templated {
                throw PrototypeContractValidator.invalid(first.at, pairMessage(key))
            }
        }
    }

    private static func resolvedKeys(
        _ key: String,
        shared: Bool,
        parent: PrototypeLocatedValue?,
        path: String,
        at: String,
        data: [String: JSONValue]?
    )
        throws -> [String]
    {
        let repeatFields = parent?.value["repeat"]?.objectFields
        func fail(_ message: String) -> PrototypeLoadError { PrototypeContractValidator.invalid(at, message) }
        if !shared, parent != nil { throw fail("sharedKey is not allowed inside repeat templates") }
        if !key.contains("{") {
            if shared, !validKey(key) { throw fail("Invalid shared key value") }
            if parent != nil, path != parent?.path { throw fail("shared key inside repeat requires a key template") }
            return [key]
        }
        guard let repeatFields, let field = repeatFields["key"]?.stringValue, path != parent?.path else {
            throw fail("shared key template requires repeat.key")
        }
        let alias = repeatFields["as"]?.stringValue ?? ""
        let segments = PrototypeRepeat.segments(key, alias: alias)
        guard segments.contains(where: { if case .field = $0 { true } else { false } }),
              !segments.contains(where: {
                  switch $0 {
                  case .index: true; case let .field(name): name != field; case let .literal(text): text
                      .contains("{") || text.contains("}")
                  }
              }) else { throw fail("shared key template must reference only repeat.key") }
        var cache = PrototypeRepeatData(data: data)
        let items: JSONValue = if let pointer = repeatFields["items"]?.objectFields?["path"]?.stringValue {
            cache.items(pointer)
        } else { repeatFields["items"] ?? .array([]) }
        let rows: [JSONValue] = if case let .array(rows) = items { rows } else { [] }
        let keys = rows.enumerated().map { index, item in
            PrototypeRepeatInstance(alias: alias, item: item.objectFields ?? [:], index: index).interpolate(key)
        }
        guard keys.allSatisfy(validKey) else { throw fail("Invalid resolved shared key value") }
        guard Set(keys).count == keys.count
        else { throw fail("shared key resolves to multiple nodes on the same side") }
        return keys
    }

    private static func validKey(_ key: String) -> Bool {
        key.range(of: "^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\\s\\S])", options: .regularExpression) != nil
    }

    private static func checkPair(_ key: String, entry: Occurrence, prior: [Occurrence], count: Int) throws {
        let message: String? = if count > 16 { "a spec allows at most 16 sharedKey values" }
        else if entry.repeatPath != nil,
                prior
                .contains(where: { $0.repeatPath == entry.repeatPath })
        {
            "shared key resolves to multiple nodes on the same side"
        } else if prior.count == 2 { pairMessage(key) }
        else if prior
            .contains(where: { entry.path.hasPrefix("\($0.path).") })
        {
            "sharedKey nodes cannot be nested in each other"
        } else if prior
            .contains(where: { $0.boundary != entry.boundary })
        {
            "shared pair cannot cross a dialog or bottomSheet boundary"
        } else if prior.contains(where: { $0.kind != entry.kind }) { "shared pair must use the same as value" }
        else { nil }
        if let message { throw PrototypeContractValidator.invalid(entry.at, message) }
    }

    private static func pairMessage(_ key: String) -> String { "sharedKey \"\(key)\" must be used by exactly two nodes"
    }
}
