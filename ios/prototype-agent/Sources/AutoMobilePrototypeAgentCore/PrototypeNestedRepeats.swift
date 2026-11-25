import Foundation

extension PrototypeRepeat {
    static func requiresNestedCapability(_ repeated: JSONValue?) -> Bool {
        let items = repeated?.objectFields?["items"]
        if items?.objectFields?["field"] != nil { return true }
        return PrototypeStrictBindings.array(items).contains { row in
            (row.objectFields ?? [:]).values.contains { value in
                if case .array = value { return true }
                return false
            }
        }
    }
}

extension PrototypeStrictRepeats {
    /// Each outer row owns an independent inner index and identity namespace, including empty rows.
    mutating func nestedTemplates(
        _ node: [String: JSONValue], path: String, outer: Scope, field: String
    )
        throws
    {
        let repeated = node["repeat"]?.objectFields ?? [:]
        let alias = repeated["as"]?.stringValue ?? "item"
        let derived = Set(repeated["derive"]?.objectFields?.keys ?? [:].keys)
        let outerDerived = Set(outer.derived.map { "outer.\($0)" })
        let sources = outer.sourceItems
        if sources.isEmpty {
            let empty = Scope(
                path: path, alias: alias, items: [], pathBound: true, sourceField: "field",
                outerAlias: outer.alias
            )
            scopes.append(empty)
            for child in Self.children(node, path: path) {
                try templates(child.value, path: child.path, scope: empty)
            }
        }
        for (index, source) in sources.enumerated() {
            let sourcePath = "\(path).repeat.items.field"
            guard let value = source[field] else {
                throw PrototypeContractValidator.invalid(
                    sourcePath,
                    "Unknown repeat field \(PrototypeContractValidator.quoted(field))"
                )
            }
            guard case let .array(rows) = value else {
                throw PrototypeContractValidator.invalid(sourcePath, "Repeat field does not resolve to an array")
            }
            guard rows.count <= PrototypeLimits.maxInnerRepeatItems else {
                throw PrototypeContractValidator.invalid(sourcePath, "Repeat field resolves to more than 100 items")
            }
            if let invalid = rows.firstIndex(where: { $0.objectFields == nil }) {
                throw PrototypeContractValidator.invalid(sourcePath, "Repeat field item \(invalid) is not an object")
            }
            if rows.contains(where: { row in
                row.objectFields?.keys.contains(where: { $0.hasPrefix("outer.") }) == true
            }) {
                throw PrototypeContractValidator.invalid(
                    sourcePath, "Inner repeat fields starting with \"outer.\" are reserved"
                )
            }
            // A derive name that is also an inner row field would replace it, as on an outer repeat (#18665).
            for name in PrototypeContractValidator.sorted(derived)
                where rows.contains(where: { $0.objectFields?[name] != nil })
            {
                throw PrototypeContractValidator.invalid(
                    "\(path).repeat.derive.\(name)",
                    "Derived name collides with an item field"
                )
            }
            let outerItem = outer.items[index]
            let items = rows.compactMap(\.objectFields).map { row in
                var item = PrototypeDataValues.project(row).objectFields ?? [:]
                for name in derived {
                    item[name] = .string("")
                }
                for (name, value) in outerItem {
                    item["outer.\(name)"] = value
                }
                item["$outerIndex"] = .number(Double(index))
                return item
            }
            let inner = Scope(
                path: path, alias: alias, items: items, pathBound: true,
                derived: derived.union(outerDerived), sourceField: "field",
                sourceItems: rows.compactMap(\.objectFields), outerAlias: outer.alias,
                outerItem: outerItem, outerIndex: index
            )
            scopes.append(inner)
            for child in Self.children(node, path: path) {
                try templates(child.value, path: child.path, scope: inner)
            }
            try identity(node, path: path, scope: inner)
        }
    }
}
