import Foundation

/// Materializes only repeat sources. Raw collections retain all original fields until this boundary.
enum PrototypeDerivedCollections {
    static func bind(_ root: JSONValue, values: [String: JSONValue]) -> JSONValue {
        guard var node = root.objectFields else { return root }
        if var repeated = node["repeat"]?.objectFields,
           let name = repeated["items"]?.objectFields?["derived"]?.stringValue
        {
            let rows = PrototypeStrictBindings.array(values[name]).map {
                PrototypeDataValues.project($0.objectFields ?? [:])
            }
            if node["type"] == .string("list") {
                repeated["items"] = .object(["derived": .string(name), "_rows": .array(rows)])
            } else {
                repeated["items"] = .array(rows)
            }
            node["repeat"] = .object(repeated)
        }
        for key in ["child", "header", "footer"] +
            (node["type"] == .string("adaptive") ? PrototypeAdaptive.slots : [])
        {
            if let child = node[key] { node[key] = bind(child, values: values) }
        }
        if case let .array(children)? = node["children"] {
            node["children"] = .array(children.map { bind($0, values: values) })
        }
        if let screens = node["screens"]?.objectFields {
            node["screens"] = .object(screens.mapValues { bind($0, values: values) })
        }
        return .object(node)
    }

    static func entries(_ raw: JSONValue?) throws -> [String: PrototypeDerivedEntry] {
        guard let raw else { return [:] }
        if let rule = PrototypeContractValidator.definition("spec")?.objectFields?["fields"]?.objectFields?["derive"]?
            .objectFields?["rule"]
        {
            try PrototypeContractValidator.validateValue(raw, rule: rule, path: "derive")
        }
        return try JSONDecoder().decode([String: PrototypeDerivedEntry].self, from: JSONEncoder().encode(raw))
    }
}
