import Foundation

/// Reject-only validation of an authored spec. No renderer, I/O, storage or networking is started.
public enum PrototypeSpecStrictValidator {
    /// Accepts by returning normally; rejects with `PrototypeLoadError.invalidSpec(path:message:)`.
    public static func validate(data: Data, supportedCapabilities: Set<String>? = nil, library: Bool = false) throws {
        do {
            let data = try PrototypeStrictJSON.prepare(data)
            let (value, context) = try PrototypeContractValidator.inspect(data: data)
            guard let fields = value.objectFields,
                  let root = fields["root"]
            else { throw PrototypeContractValidator.invalid("$", "Expected prototype envelope") }
            let state = fields["state"]?.objectFields ?? [:]
            let modelData = fields["data"]?.objectFields
            try PrototypeStrictSemantics.layout(context)
            var repeats = PrototypeStrictRepeats(data: modelData)
            try repeats.templates(root.objectFields ?? [:], path: "root")
            try PrototypeLimits.guardRepeatPathCells(root, data: modelData)
            try PrototypeLimits.guardSubstitutedText(root, data: modelData)
            try repeats.expanded(root.objectFields ?? [:], path: "root")
            try PrototypeStrictSemantics.storage(fields)
            try PrototypeDataWrite.validate(actions: context.actions, data: modelData)
            try PrototypeRequestValidator.validate(root, state: state)
            try PrototypePlatformValidator.validate(
                requires: fields["requires"],
                handlers: fields["platform"],
                root: root,
                state: state
            )
            try PrototypeTimerValidator.validate(context.actions)
            try PrototypeStrictSemantics.vocabulary(context, data: modelData)
            try PrototypeLinkify.validate(root: root, nodes: context.locatedNodes)
            try PrototypeStrictSemantics.targets(context)
            let nodes = repeats.bound(context.locatedNodes)
            let actions = repeats.bound(context.actions, actions: true)
            try PrototypeStrictBindings.validate(nodes: nodes, actions: actions, state: state)
            try PrototypeChecks.validate(nodes: nodes, actions: actions, state: state)
            try PrototypeLimits.guardAuthoredTree(root)
            try PrototypeMenus.validateAuthoredText(root)
            try PrototypeRepeat.validateEmitContexts(root, data: modelData)
            let resolved = PrototypeDataResolver.resolveRoot(root, data: modelData)
            try PrototypeLimits.guardTree(resolved)
            let expanded = PrototypeRepeat.expand(resolved)
            try PrototypePagerOptions.validate(expanded)
            try PrototypeSwipe.validate(expanded)
            try PrototypeCarousel.validate(expanded)
            try PrototypeRefresh.validate(expanded)
            try PrototypeMenus.validate(expanded, state: state)
            if let supportedCapabilities,
               !PrototypeStrictCapabilities.required(fields).isSubset(of: supportedCapabilities)
            {
                throw PrototypeContractValidator.invalid("$", "Unsupported capabilities")
            }
            if library, PrototypeCustomShaders.uses(fields) {
                throw PrototypeContractValidator.invalid(
                    "$",
                    "ProtoViewer bundles refuse custom AGSL shaders"
                )
            }
            if library, let window = fields["window"]?.objectFields {
                if window["layer"] ==
                    .string("system") { throw PrototypeContractValidator.invalid("window.layer", "Privileged window") }
                if window["persistence"] ==
                    .string("device")
                {
                    throw PrototypeContractValidator.invalid("window.persistence", "Privileged window")
                }
            }
            // Located actions exclude opaque data, request bodies and emit payloads.
            if library, let host = context.actions.first(where: {
                $0.value["type"] == .string("request") && $0.value["via"] == .string("host")
            }) {
                throw PrototypeContractValidator.invalid(
                    "\(host.path).via",
                    "Host requests are unavailable in a library"
                )
            }
            if library { try secureLibrary(
                fields,
                nodes: context.locatedNodes,
                actions: context.actions,
                repeats: repeats
            ) }
        } catch let error as PrototypeLoadError { throw error }
        catch let DecodingError.dataCorrupted(context) {
            if let separator = context.debugDescription.range(of: ": ") {
                throw PrototypeLoadError.invalidSpec(
                    path: String(context.debugDescription[..<separator.lowerBound]),
                    message: String(context.debugDescription[separator.upperBound...])
                )
            }
            throw PrototypeContractValidator.invalid("$", context.debugDescription)
        } catch { throw PrototypeContractValidator.invalid("$", error.localizedDescription) }
    }

    private static func secureLibrary(
        _ fields: [String: JSONValue], nodes: [PrototypeLocatedValue],
        actions: [PrototypeLocatedValue], repeats: PrototypeStrictRepeats
    )
        throws
    {
        let secureNodes = nodes.filter { node in
            let value = node.value
            return value["type"] == .string("textField") &&
                (value["secure"] == .bool(true) || value["keyboardType"] == .string("password"))
        }.map { PrototypeLocatedValue(value: ["stateKey": $0.value["stateKey"] ?? .null], path: $0.path) }
        let secure = Set(repeats.bound(secureNodes).compactMap { $0.value["stateKey"]?.stringValue })
        guard !secure.isEmpty else { return }
        var bindings: [(text: String, path: String, key: Bool, request: Bool)] = []
        func append(_ raw: JSONValue?, path: String, request: Bool = false) {
            if let text = raw?.stringValue { bindings.append((text, path, false, request)) }
            if let key = raw?.objectFields?["state"]?.stringValue {
                bindings.append((key, "\(path).state", true, request))
            }
        }
        for action in actions {
            switch action.value["type"]?.stringValue {
            case "request":
                append(action.value["url"], path: "\(action.path).url", request: true)
                for name in ["headers", "query"] {
                    for (key, value) in action.value[name]?.objectFields ?? [:] {
                        append(
                            value,
                            path: PrototypeLimits.dataMemberPath("\(action.path).\(name)", key: key),
                            request: true
                        )
                    }
                }
                append(action.value["body"], path: "\(action.path).body", request: true)
            case "setData", "appendData":
                append(action.value["value"], path: "\(action.path).value")
            case "emit", "platform":
                let name = action.value["type"] == .string("emit") ? "context" : "args"
                for (key, value) in action.value[name]?.objectFields ?? [:] {
                    append(value, path: PrototypeLimits.dataMemberPath("\(action.path).\(name)", key: key))
                }
            default:
                break
            }
        }
        for binding in bindings.sorted(by: { $0.path.utf16.lexicographicallyPrecedes($1.path.utf16) }) {
            let scope = repeats.scopes.first {
                binding.path.hasPrefix("\($0.path).children[") && PrototypeRepeat
                    .segments(binding.text, alias: $0.alias)
                    .contains { if case .literal = $0 { return false }; return true }
            }
            let texts = scope.map { scope in
                scope.items.enumerated().map { index, item in
                    PrototypeRepeatInstance(alias: scope.alias, item: item, index: index).interpolate(binding.text)
                }
            } ?? [binding.text]
            if texts.contains(where: { text in
                binding.key ? secure.contains(text) : secure.contains { text.contains("{\($0)}") }
            }) {
                throw PrototypeContractValidator.invalid(
                    binding.path,
                    binding.request
                        ? "Secure value cannot be bound into a request"
                        : "Secure value cannot be bound into an action payload"
                )
            }
        }
        for (index, raw) in PrototypeStrictBindings.array(fields["storage"]?.objectFields?["keys"]).enumerated() {
            if let key = raw.stringValue, key.hasPrefix("state:"), secure.contains(String(key.dropFirst(6))) {
                throw PrototypeContractValidator.invalid("storage.keys[\(index)]", "Secure value cannot be persisted")
            }
        }
    }
}
