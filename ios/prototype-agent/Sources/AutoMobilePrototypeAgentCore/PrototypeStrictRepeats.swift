import Foundation

/// Authored repeat diagnostics composed with the runtime's projection, tokenization and binder.
struct PrototypeStrictRepeats {
    struct Scope {
        let path: String
        let alias: String
        let items: [[String: JSONValue]]
        let pathBound: Bool
        var derived: Set<String> = []
    }

    var scopes: [Scope] = []
    let data: [String: JSONValue]?
    var nodes = 0
    var images = 0
    var effects = PrototypeEffectUses()

    static func children(_ node: [String: JSONValue], path: String) -> [PrototypeLocatedValue] {
        var result: [PrototypeLocatedValue] = []
        for name in ["header", "footer"] {
            if let child = node[name]?.objectFields { result.append(.init(value: child, path: "\(path).\(name)")) }
        }
        if let child = node["child"]?.objectFields { result.append(.init(value: child, path: "\(path).child")) }
        for (index, value) in PrototypeStrictBindings.array(node["children"]).enumerated() {
            if let child = value.objectFields { result.append(.init(value: child, path: "\(path).children[\(index)]")) }
        }
        if let screens = node["screens"]?.objectFields {
            for key in PrototypeContractValidator.sorted(screens.keys) {
                if let child = screens[key]?.objectFields { result.append(.init(
                    value: child,
                    path: PrototypeStacks.screenPath(path, name: key)
                )) }
            }
        }
        return result
    }

    mutating func templates(_ node: [String: JSONValue], path: String, scope: Scope? = nil) throws {
        if scope != nil {
            if node["repeat"] !=
                nil { throw PrototypeContractValidator.invalid("\(path).repeat", "Nested repeat is not supported") }
            if ["pager", "stack"]
                .contains(node["type"]?.stringValue ?? "")
            {
                throw PrototypeContractValidator.invalid(
                    path,
                    node["type"] == .string("pager") ? "Pager cannot appear inside a repeat template" :
                        "Stack cannot appear inside a repeat template"
                )
            }
        }
        try fields(
            .object(node.filter { !["child", "children", "screens", "repeat", "header", "footer"].contains($0.key) }),
            path: path,
            scope: scope
        )
        var own: Scope?
        if let spec = node["repeat"]?.objectFields, let alias = spec["as"]?.stringValue {
            let source = spec["items"]
            let pathBound = source?.objectFields != nil
            let items: [JSONValue]
            if let pointer = source?.objectFields?["path"]?.stringValue {
                let at = "\(path).repeat.items.path"
                guard case let .array(resolved)? = PrototypeDataPointer.resolve(data, pointer: pointer),
                      resolved
                      .count <=
                      (node["type"] == .string("list") ? PrototypeLimits.maxListItems : PrototypeLimits.maxRepeatItems),
                      resolved.allSatisfy({ $0.objectFields != nil })
                else { throw PrototypeContractValidator.invalid(
                    at,
                    "Invalid repeat source"
                ) }
                items = resolved.map { PrototypeDataValues.project($0.objectFields ?? [:]) }
            } else { items = PrototypeStrictBindings.array(source) }
            let derived = Set(spec["derive"]?.objectFields?.keys ?? [:].keys)
            let projected = items.compactMap(\.objectFields).map { item in
                item
                    .merging(Dictionary(uniqueKeysWithValues: derived.map { ($0, JSONValue.string("")) })) { old, _ in
                        old
                    }
            }
            let created = Scope(path: path, alias: alias, items: projected, pathBound: pathBound, derived: derived)
            own = created
            scopes.append(created)
        }
        for child in Self
            .children(node, path: path)
        {
            try templates(
                child.value,
                path: child.path,
                scope: child.path.hasPrefix("\(path).children[") ? own ?? scope : scope
            )
        }
        if let own, let key = node["repeat"]?.objectFields?["key"]?.stringValue, !own.derived.contains(key) {
            var seen: [[UInt16]: Int] = [:]
            for (index, item) in own.items.enumerated() {
                guard let value = item[key] else {
                    throw PrototypeContractValidator.invalid(
                        "\(path).repeat.key",
                        "Unknown repeat field \(PrototypeContractValidator.quoted(key))"
                    )
                }
                let identity = Array(value.displayString.utf16)
                if let previous = seen[identity] {
                    throw PrototypeContractValidator.invalid(
                        "\(path).repeat.key",
                        "Duplicate repeat key \(PrototypeContractValidator.quoted(value.displayString)) (items \(previous) and \(index))"
                    )
                }
                seen[identity] = index
            }
        }
    }

    private func fields(_ value: JSONValue, path: String, scope: Scope?, dataCondition: Bool = false) throws {
        if case let .array(items) = value {
            for (index, child) in items.enumerated() {
                try fields(
                    child,
                    path: "\(path)[\(index)]",
                    scope: scope,
                    dataCondition: dataCondition
                )
            }
            return
        }
        guard let object = value.objectFields else { return }
        if object.count == 1, object["value"] != nil { return }
        for key in PrototypeContractValidator.sorted(object.keys) {
            guard !["payload", "style"].contains(key), let child = object[key] else { continue }
            let at = PrototypeContractValidator.keyPath(path, key)
            if let text = child.stringValue {
                let keyField = ["stateKey", "activeKey", "hourKey", "minuteKey", "atEndKey", "statusKey", "state"]
                    .contains(key)
                    || (key == "key" && object["repeat"] == nil)
                let dataActionPath = key == "path"
                    && PrototypeDataWrite.actionTypes.contains(object["type"]?.stringValue ?? "")
                let appendTarget = (key == "to" && object["from"] != nil) || dataActionPath
                if appendTarget {
                    if let scope {
                        if PrototypeRepeat.segments(text, alias: scope.alias).contains(where: {
                            if case .field = $0 { return true }; return false
                        }) {
                            throw PrototypeContractValidator.invalid(
                                at,
                                "Only a whole {index} segment may be a placeholder in a data path"
                            )
                        }
                        if text.split(separator: "/", omittingEmptySubsequences: false).contains(where: {
                            $0.contains("{index}") && $0 != "{index}"
                        }) { throw PrototypeContractValidator.invalid(at, "{index} must be a whole data path segment") }
                    } else if text.contains("{index}") {
                        throw PrototypeContractValidator.invalid(at, "{index} outside a repeat template")
                    }
                }
                if let scope {
                    let segments = PrototypeRepeat.segments(text, alias: scope.alias)
                    let templated = segments.contains { if case .literal = $0 { return false }; return true }
                    if dataCondition, templated { throw PrototypeContractValidator.invalid(
                        at,
                        "Template in data condition"
                    ) }
                    for segment in segments {
                        if case let .field(name) = segment, !scope.items.allSatisfy({ $0[name] != nil }) {
                            throw PrototypeContractValidator.invalid(
                                at,
                                "Unknown repeat field \(PrototypeContractValidator.quoted(name))"
                            )
                        }
                    }
                    if keyField,
                       !segments
                       .contains(where: {
                           if case let .field(name) = $0 { return scope.derived.contains(name) }; return false
                       })
                    {
                        for (index, item) in scope.items.enumerated() {
                            let bound = PrototypeRepeatInstance(alias: scope.alias, item: item, index: index)
                                .interpolate(text)
                            if !PrototypeContractValidator.primitive(.string(bound), rule: ["kind": .string("key")]) {
                                let at = scope
                                    .pathBound ? "\(scope.path).repeat.items.path" :
                                    "\(scope.path).repeat.items[\(index)]"
                                throw PrototypeContractValidator.invalid(at, "Invalid bound key")
                            }
                        }
                    }
                    if key == "item",
                       !scope.items
                       .allSatisfy({ $0[text] != nil })
                    {
                        throw PrototypeContractValidator.invalid(path, "Unknown repeat field")
                    }
                } else if keyField, !PrototypeContractValidator.primitive(child, rule: ["kind": .string("key")]) {
                    throw PrototypeContractValidator.invalid(at, "State key placeholder outside a repeat template")
                }
            } else {
                try fields(
                    child,
                    path: at,
                    scope: scope,
                    dataCondition: object["data"] != nil && ["equals", "notEquals", "gt", "lt"].contains(key)
                )
            }
            if object["data"] != nil, ["equals", "notEquals", "gt", "lt"].contains(key), let text = child.stringValue,
               let scope,
               PrototypeRepeat.segments(text, alias: scope.alias)
               .contains(where: { if case .literal = $0 { return false }; return true })
            {
                throw PrototypeContractValidator.invalid(at, "Template in data condition")
            }
        }
    }

    mutating func expanded(_ node: [String: JSONValue], path: String, repeatPath: String? = nil) throws {
        let at = repeatPath ?? path
        nodes += 1
        images += node["type"] == .string("image") ? max(1, imageUses(node["asset"])) : PrototypeStrictBindings
            .array(node["items"]).reduce(0) { $0 + imageUses($1.objectFields?["image"]) }
        if nodes > PrototypeLimits.maxNodes { throw PrototypeContractValidator.invalid(
            at,
            "Expanded node limit exceeded"
        ) }
        if images > 32 { throw PrototypeContractValidator.invalid(at, "Expanded image limit exceeded") }
        effects.add(PrototypeEffectUses(node: node))
        if effects.total > PrototypeContractValidator.limit("MAX_PROTOTYPE_EFFECTS") {
            throw PrototypeContractValidator.invalid(at, "Expanded effect limit exceeded")
        }
        if effects.animated > PrototypeContractValidator.limit("MAX_PROTOTYPE_ANIMATED_EFFECTS") {
            throw PrototypeContractValidator.invalid(at, "Expanded animated effect limit exceeded")
        }
        let scope = scopes.first { $0.path == path }
        for _ in 0 ..< (node["type"] == .string("list") ? 1 : (scope?.items.count ?? 1)) {
            for child in Self.children(node, path: path) {
                try expanded(
                    child.value,
                    path: child.path,
                    repeatPath: scope == nil ? repeatPath : "\(path).repeat"
                )
            }
        }
    }

    private func imageUses(_ raw: JSONValue?) -> Int {
        if raw?.stringValue != nil { return 1 }
        guard let fields = raw?.objectFields else { return 0 }
        return Set([fields["light"], fields["dark"]].compactMap { $0?.stringValue.map { Array($0.utf16) } }).count
    }

    func bound(_ entries: [PrototypeLocatedValue], actions: Bool = false) -> [PrototypeLocatedValue] {
        entries.flatMap { entry -> [PrototypeLocatedValue] in
            guard let scope = scopes.first(where: { entry.path.hasPrefix("\($0.path).children[") })
            else { return [entry] }
            let keys = PrototypeStrictBindings.boundKeys(entry.value) + [entry.value["key"]?.stringValue]
                .compactMap { $0 }
            if keys.contains(where: { key in
                PrototypeRepeat.segments(key, alias: scope.alias).contains {
                    if case let .field(name) = $0 { return scope.derived.contains(name) }
                    return false
                }
            }) { return [] }
            let operand = entry.value["value"]?.stringValue ?? ""
            let templated = PrototypeRepeat.segments(operand, alias: scope.alias)
                .contains { if case .literal = $0 { return false }; return true }
            guard keys
                .contains(where: {
                    PrototypeRepeat.segments($0, alias: scope.alias)
                        .contains { if case .literal = $0 { return false }; return true }
                })
            else {
                return [.init(value: entry.value, path: entry.path, operandTemplated: templated)]
            }
            return scope.items.enumerated().map { index, item in
                let instance = PrototypeRepeatInstance(alias: scope.alias, item: item, index: index)
                let value = actions ? instance.bindAction(.object(entry.value)) : instance.bind(.object(entry.value))
                return .init(value: value.objectFields ?? entry.value, path: entry.path, operandTemplated: templated)
            }
        }
    }
}
