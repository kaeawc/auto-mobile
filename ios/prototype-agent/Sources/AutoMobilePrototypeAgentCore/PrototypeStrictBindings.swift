import Foundation

struct PrototypeLocatedValue {
    let value: [String: JSONValue]
    let path: String
    var operandTemplated = false
}

/// Located diagnostics for the binding rules also used for runtime state writes.
/// The raw contract view retains authored paths and options the renderer does not store.
enum PrototypeStrictBindings {
    typealias Fields = [String: JSONValue]
    private static func control(_ fields: Fields) throws -> PrototypeNode {
        // Children are independently visited at authored paths; decoding this shallow control
        // reuses runtime state validation without building a render tree or expanding repeats.
        var own = fields.filter { [
            "type",
            "stateKey",
            "activeKey",
            "hourKey",
            "minuteKey",
            "min",
            "max",
            "step",
            "variant",
            "label",
            "size",
            "options",
            "openWhen",
            "trailing",
            "multiline",
            "minLines",
            "maxLines",
            "maxLength",
            "secure",
            "keyboardType",
            "imeAction",
        ].contains($0.key) }
        if fields["type"] == .string("menu") { own["items"] = .array([]) }
        if fields["onSubmit"] != nil { own["onSubmit"] = .array([]) }
        if let refresh = fields["refresh"]?
            .objectFields
        {
            own["refresh"] = .object(["stateKey": refresh["stateKey"] ?? .null, "onRefresh": .array([])])
        }
        return try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(JSONValue.object(own)))
    }

    static func field(_ node: Fields, state: Fields) throws -> String? {
        try PrototypeStateValidator.bindingRejection(control(node), state)?.field
    }

    static func array(_ value: JSONValue?) -> [JSONValue] {
        if case let .array(items)? = value { return items }; return []
    }

    static func secondary(_ fields: Fields, state: Fields) throws -> String? {
        let node = try control(fields)
        if let rejection = PrototypeStateValidator.trailingError(node, state) ?? PrototypeStateValidator.openWhenError(
            node,
            state
        ) ?? PrototypeStateValidator.refreshError(node, state) { return rejection.field }
        if node.type == "scroll" {
            if fields["refresh"] != nil, fields["axis"] == .string("horizontal") { return "refresh" }
            if let key = fields["atEndKey"]?.stringValue, state[key]?.boolValue == nil { return "atEndKey" }
        }
        return nil
    }

    static func boundKeys(_ node: Fields) -> [String] {
        [
            node["stateKey"],
            node["activeKey"],
            node["hourKey"],
            node["minuteKey"],
            node["trailing"]?.objectFields?["stateKey"],
            node["refresh"]?.objectFields?["stateKey"],
            node["openWhen"]?.objectFields?["key"],
            node["atEndKey"],
        ].compactMap { $0?.stringValue }
    }

    static func validate(nodes: [PrototypeLocatedValue], actions: [PrototypeLocatedValue], state: Fields) throws {
        for node in nodes {
            if let field = try field(node.value, state: state) { throw PrototypeContractValidator.invalid(
                "\(node.path).\(field)",
                "Invalid control binding"
            ) }
        }
        for node in nodes {
            if let field = try secondary(node.value, state: state) { throw PrototypeContractValidator.invalid(
                "\(node.path).\(field)",
                "Invalid control binding"
            ) }
        }
        for action in actions {
            let value = action.value, type = value["type"]?.stringValue
            if let key = value["key"]?.stringValue {
                if type == "toggle",
                   state[key]?
                   .boolValue ==
                   nil { throw PrototypeContractValidator.invalid("\(action.path).key", "Expected boolean state") }
                if type == "increment" || type == "decrement",
                   state[key]?
                   .numberValue ==
                   nil { throw PrototypeContractValidator.invalid("\(action.path).key", "Expected numeric state") }
                if type == "setState", !action.operandTemplated, let operand = value["value"] {
                    let controls = nodes.filter { boundKeys($0.value).contains(key) }
                    if Set(controls.compactMap { $0.value["type"]?.stringValue }).count == 1 {
                        var written = state
                        written[key] = operand.objectFields?["match"] == nil ? operand : .string("")
                        if try controls.contains(where: {
                            let first = try field($0.value, state: written)
                            let second = try secondary($0.value, state: written)
                            return first != nil || second != nil
                        }) {
                            throw PrototypeContractValidator.invalid(
                                "\(action.path).value",
                                "setState value does not fit control"
                            )
                        }
                    }
                }
            }
        }
    }
}
