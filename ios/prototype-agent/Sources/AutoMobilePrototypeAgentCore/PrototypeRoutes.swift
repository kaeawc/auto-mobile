import Foundation

/// Contract-only relationships. Navigation, events and persisted-path restoration are a later slice.
enum PrototypeRoutes {
    static func fields(_ text: String) -> [String] {
        PrototypeRepeat.segments(text, alias: "route")
            .compactMap { if case let .field(name) = $0 { name } else { nil } }
    }

    static func validate(_: [String: JSONValue], context: PrototypeContractValidator) throws {
        let stacks = context.locatedNodes.filter { $0.value["type"] == .string("stack") }
        for stack in stacks {
            let screens = stack.value["screens"]?.objectFields ?? [:]
            for name in PrototypeContractValidator.sorted((stack.value["routes"]?.objectFields ?? [:]).keys) {
                let route = stack.value["routes"]?.objectFields?[name]?.objectFields ?? [:]
                let at = PrototypeContractValidator.keyPath("\(stack.path).routes", name)
                if screens[name] == nil { throw PrototypeContractValidator.invalid(at, "Unknown route screen") }
                for key in PrototypeContractValidator.sorted((route["params"]?.objectFields ?? [:]).keys) {
                    if !PrototypeContractValidator.matches("pathKey", key) {
                        throw PrototypeContractValidator.invalid(
                            PrototypeContractValidator.keyPath("\(at).params", key),
                            "Invalid route param name"
                        )
                    }
                }
                for list in ["onEnter", "onBack"] {
                    if let actions = route[list] { try placeholders(
                        actions,
                        path: "\(at).\(list)",
                        params: route["params"]?.objectFields ?? [:]
                    ) }
                }
                for (index, raw) in PrototypeStrictBindings.array(route["onBack"]).enumerated() {
                    let action = raw.objectFields ?? [:]
                    if action["type"] == .string("pop"), action["stack"] == stack.value["id"],
                       action["force"] != .bool(true)
                    {
                        throw PrototypeContractValidator.invalid(
                            "\(at).onBack[\(index)]",
                            "Direct onBack pop requires force: true"
                        )
                    }
                }
            }
        }
        for action in context.actions
            where ["push", "replace", "setStack"].contains(action.value["type"]?.stringValue ?? "")
        {
            guard let stack = stacks.first(where: { $0.value["id"] == action.value["stack"] }) else { continue }
            let entries = action.value["type"] == .string("setStack") ? PrototypeStrictBindings
                .array(action.value["path"]) : [.object(action.value)]
            for raw in entries {
                let entry = raw.objectFields ?? [:]
                let screen = entry["screen"]?.stringValue ?? ""
                if stack.value["screens"]?.objectFields?[screen] == nil {
                    if action
                        .value["type"] ==
                        .string("setStack")
                    {
                        throw PrototypeContractValidator.invalid(action.path, "Unknown stack screen")
                    }
                    continue
                }
                let declared = stack.value["routes"]?.objectFields?[screen]?.objectFields?["params"]?
                    .objectFields ?? [:]
                let params = entry["params"]?.objectFields ?? [:]
                for name in PrototypeContractValidator.sorted(params.keys) {
                    if !PrototypeContractValidator
                        .matches("pathKey", name)
                    {
                        throw PrototypeContractValidator.invalid(action.path, "Invalid route param name")
                    }
                    if declared[name] == nil { throw PrototypeContractValidator.invalid(
                        action.path,
                        "Undeclared route param \(PrototypeContractValidator.quoted(name))"
                    ) }
                    if let value = params[name], value.isScalar {
                        let type: String = switch value {
                        case .string: "string"; case .bool: "boolean"; default: "number"
                        }
                        if declared[name] != .string(type) { throw PrototypeContractValidator.invalid(
                            action.path,
                            "Wrong type for route param \(PrototypeContractValidator.quoted(name))"
                        ) }
                    }
                }
                for name in PrototypeContractValidator.sorted(declared.keys) where params[name] == nil {
                    throw PrototypeContractValidator.invalid(
                        action.path,
                        "Missing route param \(PrototypeContractValidator.quoted(name))"
                    )
                }
            }
        }
        for node in context.locatedNodes {
            if node.value["repeat"]?
                .objectFields?["as"] ==
                .string("route")
            {
                throw PrototypeContractValidator
                    .invalid("\(node.path).repeat.as", "route is reserved for route params")
            }
            let owners = stacks.flatMap { stack in
                (stack.value["screens"]?.objectFields ?? [:]).keys.map { name in
                    (
                        PrototypeStacks.screenPath(stack.path, name: name),
                        stack.value["routes"]?.objectFields?[name]?.objectFields?["params"]?.objectFields ?? [:]
                    )
                }
            }.filter { node.path == $0.0 || node.path.hasPrefix("\($0.0).") }.sorted { $0.0.count > $1.0.count }
            try placeholders(
                .object(node.value.filter { !["child", "children", "screens", "routes"].contains($0.key) }),
                path: node.path,
                params: owners.first?.1
            )
        }
    }

    /// Uses the repeat tokenizer; only bindable strings are inspected, never opaque payload values.
    private static func placeholders(
        _ value: JSONValue,
        path: String,
        params: [String: JSONValue]?,
        field: String = ""
    )
        throws
    {
        if let text = value.stringValue {
            let names = fields(text)
            for name in names {
                guard let params else { throw PrototypeContractValidator.invalid(
                    path,
                    "Route placeholder outside a screen"
                ) }
                if params[name] == nil { throw PrototypeContractValidator.invalid(
                    path,
                    "Undeclared route param \(PrototypeContractValidator.quoted(name))"
                ) }
            }
            if ["path", "into", "data"].contains(field), !names.isEmpty,
               text.split(separator: "/").contains(where: { part in
                   let segment = String(part)
                   let names = fields(segment)
                   return !names.isEmpty && (names.count != 1 || segment != "{route.\(names[0])}")
               })
            { throw PrototypeContractValidator.invalid(
                path,
                "Route placeholder must occupy a whole data pointer segment"
            ) }
            return
        }
        if case let .array(items) = value {
            for (index, child) in items.enumerated() {
                try placeholders(
                    child,
                    path: "\(path)[\(index)]",
                    params: params,
                    field: field
                )
            }
        }
        guard let object = value.objectFields else { return }
        if object.count == 1, object["value"] != nil { return }
        // Share the repeat binder's text-slot selection; an unbound label remains literal.
        var textProjection = object
        PrototypeRepeat.bindTextFields(&textProjection) { $0 + "\u{0}" }
        let textKeys: Set<String> = [
            "text",
            "label",
            "headline",
            "supporting",
            "title",
            "placeholder",
            "supportingText",
            "trailingText",
            "message",
        ]
        let strings: Set<String> = [
            "text",
            "label",
            "headline",
            "supporting",
            "title",
            "placeholder",
            "supportingText",
            "trailingText",
            "message",
            "name",
            "equals",
            "notEquals",
            "key",
            "valid",
            "requireValid",
            "stateKey",
            "activeKey",
            "hourKey",
            "minuteKey",
            "atEndKey",
            "statusKey",
            "state",
            "path",
            "into",
            "data",
            "value",
            "url",
        ]
        for key in PrototypeContractValidator.sorted(object.keys) {
            guard !["payload", "style", "repeat"].contains(key), let child = object[key] else { continue }
            if key == "params", object["screen"] == nil { continue }
            if child.stringValue != nil, object["type"] != nil, textKeys.contains(key),
               textProjection[key] == child { continue }
            if child.stringValue != nil, !strings.contains(key),
               !["params", "headers", "query"].contains(field) { continue }
            try placeholders(child, path: PrototypeContractValidator.keyPath(path, key), params: params, field: key)
        }
    }
}
