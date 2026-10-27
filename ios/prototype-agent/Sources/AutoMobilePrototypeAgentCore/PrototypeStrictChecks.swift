import Foundation

extension PrototypeChecks {
    /// The portable check grammar and applicability, independently of the current value passing.
    static func validate(
        nodes: [PrototypeLocatedValue],
        actions: [PrototypeLocatedValue],
        state: [String: JSONValue]
    )
        throws
    {
        var keys = Set<String>()
        for node in nodes where !PrototypeStrictBindings.array(node.value["checks"]).isEmpty {
            for key in ["stateKey", "hourKey", "minuteKey"] {
                if let name = node.value[key]?.stringValue, state[name] != nil { keys.insert(name) }
            }
        }
        for node in nodes {
            let checks = PrototypeStrictBindings.array(node.value["checks"]).compactMap(\.objectFields)
            let type = node.value["type"]?.stringValue ?? ""
            for (index, check) in checks.enumerated() {
                guard let kind = check.keys.first(where: { $0 != "message" }) else { continue }
                let path = "\(node.path).checks[\(index)].\(kind)"
                if !PrototypeContractValidator.checkFits(kind, type) {
                    throw PrototypeContractValidator.invalid(path, "Check does not fit control")
                }
                if let pattern = check["pattern"]?.stringValue, !PrototypeCheckPattern.withinLimits(pattern) {
                    throw PrototypeContractValidator.invalid(path, "Invalid portable pattern")
                }
            }
            for (lower, upper) in [("min", "max"), ("minLength", "maxLength")] {
                if let low = checks.compactMap({ $0[lower]?.numberValue }).max(),
                   let high = checks.compactMap({ $0[upper]?.numberValue }).min(), low > high,
                   let index = checks.firstIndex(where: { $0[upper]?.numberValue == high })
                {
                    throw PrototypeContractValidator.invalid(
                        "\(node.path).checks[\(index)].\(upper)",
                        "Inverted check bounds"
                    )
                }
            }
            for key in ["visibleWhen", "enabledWhen", "errorWhen"] {
                try condition(node.value[key], path: "\(node.path).\(key)", keys: keys)
            }
            for (index, style) in PrototypeStrictBindings.array(node.value["styleWhen"]).enumerated() {
                try condition(style.objectFields?["when"], path: "\(node.path).styleWhen[\(index)].when", keys: keys)
            }
        }
        for action in actions {
            if let value = action.value["requireValid"] { try validityKeys(value, path: action.path, keys: keys) }
        }
    }

    private static func validityKeys(_ value: JSONValue, path: String, keys: Set<String>) throws {
        let values: [JSONValue] = if case let .array(items) = value { items } else { [value] }
        if values.contains(where: { $0.stringValue.map { !keys.contains($0) } ?? true }) {
            throw PrototypeContractValidator.invalid(path, "Validity key needs declared state with a check")
        }
    }

    private static func condition(_ raw: JSONValue?, path: String, keys: Set<String>) throws {
        guard let fields = raw?.objectFields else { return }
        if let valid = fields["valid"] { try validityKeys(valid, path: path, keys: keys); return }
        if let not = fields["not"] { try condition(not, path: "\(path).not", keys: keys); return }
        for key in ["all", "any"] {
            for (index, child) in PrototypeStrictBindings.array(fields[key]).enumerated() {
                try condition(child, path: "\(path).\(key)[\(index)]", keys: keys)
            }
        }
    }
}
