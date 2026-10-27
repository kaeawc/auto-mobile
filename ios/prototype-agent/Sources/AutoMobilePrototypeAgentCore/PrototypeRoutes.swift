import Foundation

/// Contract-only relationships. Navigation, events and persisted-path restoration are a later slice.
enum PrototypeRoutes {
    static func fields(_ text: String) -> [String] {
        PrototypeRepeat.segments(text, alias: "route")
            .compactMap { if case let .field(name) = $0 { name } else { nil } }
    }

    static func validate(_ spec: [String: JSONValue], context: PrototypeContractValidator) throws {
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
                if stack.value["start"] == .string(name), !(route["params"]?.objectFields ?? [:]).isEmpty {
                    throw PrototypeContractValidator.invalid("\(at).params", "Start screen cannot declare route params")
                }
                for action in context.actions {
                    if action.path.hasPrefix("\(at).onBack["), action.value["type"] == .string("pop"),
                       action.value["stack"] == stack.value["id"], action.value["force"] != .bool(true)
                    {
                        throw PrototypeContractValidator.invalid(action.path, "Direct onBack pop requires force: true")
                    }
                    if action.path.hasPrefix("\(at).onEnter["),
                       ["push", "replace"].contains(action.value["type"]?.stringValue ?? ""),
                       action.value["stack"] == stack.value["id"], action.value["screen"] == .string(name)
                    {
                        throw PrototypeContractValidator.invalid(
                            action.path,
                            "onEnter cannot navigate to its own screen"
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
        let owners = stacks.flatMap { stack in
            (stack.value["screens"]?.objectFields ?? [:]).keys.map { name in
                (
                    prefix: PrototypeStacks.screenPath(stack.path, name: name),
                    lifecycle: PrototypeContractValidator.keyPath("\(stack.path).routes", name),
                    params: stack.value["routes"]?.objectFields?[name]?.objectFields?["params"]?.objectFields ?? [:]
                )
            }
        }
        let ownerByPath = Dictionary(uniqueKeysWithValues: owners.flatMap { owner in
            [(owner.prefix, owner.params), (owner.lifecycle, owner.params)]
        })
        let usesRoutes = uses(spec, context: context)
        let aliases = context.locatedNodes.filter { $0.value["repeat"]?.objectFields?["as"] == .string("route") }
            .map { "\($0.path).children[" }
        func validate(_ field: PrototypeRouteFields.Field) throws {
            if !usesRoutes, aliases.contains(where: { field.path.hasPrefix($0) }) { return }
            var parent = field.path
            var params: [String: JSONValue]?
            while params == nil, let dot = parent.lastIndex(of: ".") {
                parent = String(parent[..<dot])
                params = ownerByPath[parent]
            }
            for name in fields(field.text) {
                guard let params else { throw PrototypeContractValidator.invalid(
                    field.path,
                    "Route placeholder outside a screen"
                ) }
                if params[name] == nil { throw PrototypeContractValidator.invalid(
                    field.path, "Undeclared route param \(PrototypeContractValidator.quoted(name))"
                ) }
            }
            if field.pointer, field.text.split(separator: "/").contains(where: { part in
                let names = fields(String(part))
                return !names.isEmpty && (names.count != 1 || part != "{route.\(names[0])}")
            }) { throw PrototypeContractValidator.invalid(
                field.path,
                "Route placeholder must occupy a whole data pointer segment"
            ) }
        }
        for node in context.locatedNodes {
            if usesRoutes, node.value["repeat"]?.objectFields?["as"] == .string("route") {
                throw PrototypeContractValidator.invalid("\(node.path).repeat.as", "route is reserved for route params")
            }
            for field in PrototypeRouteFields.own(node.value, path: node.path) {
                try validate(field)
            }
        }
        for action in context.actions where action.path.hasPrefix("platform.on[") {
            for field in PrototypeRouteFields.action(action.value, path: action.path) {
                try validate(field)
            }
        }
    }

    static func uses(_ spec: [String: JSONValue], context: PrototypeContractValidator) -> Bool {
        let aliases = context.locatedNodes.filter { $0.value["repeat"]?.objectFields?["as"] == .string("route") }
            .map { "\($0.path).children[" }
        func unshadowed(_ field: PrototypeRouteFields.Field) -> Bool { !aliases
            .contains { field.path.hasPrefix($0) } && !fields(field.text).isEmpty
        }
        return context.locatedNodes.contains { $0.value["type"] == .string("stack") && $0.value["routes"] != nil } ||
            context.actions.contains { action in
                let type = action.value["type"]?.stringValue ?? ""
                return type == "setStack" || (["push", "replace"].contains(type) && action.value["params"] != nil) ||
                    (type == "pop" && action.value["force"] != nil) ||
                    PrototypeRouteFields.action(action.value, path: action.path).contains(where: unshadowed)
            } || PrototypeContractValidator.strings(spec["storage"]?.objectFields?["keys"])
            .contains { $0.hasPrefix("stack:") } ||
            context.locatedNodes
            .contains { node in PrototypeRouteFields.own(node.value, path: node.path).contains(where: unshadowed) }
    }
}
