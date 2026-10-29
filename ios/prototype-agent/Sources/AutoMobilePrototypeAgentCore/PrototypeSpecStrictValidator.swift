import Foundation

/// Reject-only validation of an authored spec. No renderer, I/O, storage or networking is started.
public enum PrototypeSpecStrictValidator {
    /// Accepts by returning normally; rejects with `PrototypeLoadError.invalidSpec(path:message:)`.
    public static func validate(
        data: Data,
        supportedCapabilities: Set<String>? = nil,
        library: Bool = false,
        shareAssetIds: Set<String>? = nil
    )
        throws
    {
        do {
            let data = try PrototypeStrictJSON.prepare(data)
            let (value, context) = try PrototypeContractValidator.inspect(data: data)
            guard let fields = value.objectFields,
                  let root = fields["root"]
            else { throw PrototypeContractValidator.invalid("$", "Expected prototype envelope") }
            let state = fields["state"]?.objectFields ?? [:]
            let modelData = fields["data"]?.objectFields
            try PrototypeRoutes.validate(fields, context: context)
            try PrototypeStrings.validate(spec: fields, nodes: context.locatedNodes)
            try PrototypeLazyList.validate(root: root, data: modelData, state: state)
            try PrototypeLazyList.validateAppend(actions: context.actions, data: modelData)
            try PrototypeDerivedValidator.validate(derive: fields["derive"], root: root, data: modelData)
            try PrototypeScrollMotion.validate(root, data: modelData)
            try PrototypeSharedElementPlan.validate(context.locatedNodes, data: modelData, actions: context.actions)
            try PrototypeStrictSemantics.layout(context)
            try PrototypeStrictSemantics.pagerStateKeys(context)
            var repeats = PrototypeStrictRepeats(data: modelData)
            try repeats.templates(root.objectFields ?? [:], path: "root")
            try PrototypeLimits.guardRepeatPathCells(root, data: modelData)
            try PrototypeLimits.guardSubstitutedText(root, data: modelData)
            try repeats.expanded(root.objectFields ?? [:], path: "root")
            try PrototypeStrictSemantics.storage(fields, context: context)
            try PrototypeDataWrite.validate(actions: context.actions, data: modelData)
            try PrototypeRequestValidator.validateActions(context.actions, state: state)
            try PrototypePlatformValidator.validateTestTags(nodes: context.locatedNodes)
            try PrototypePlatformValidator.validate(
                requires: fields["requires"],
                handlers: fields["platform"],
                channels: fields["channels"],
                auth: fields["auth"],
                storage: fields["storage"],
                location: fields["location"],
                notifications: fields["notifications"],
                media: fields["media"],
                root: root,
                state: state
            )
            try PrototypeMedia.validateNodes(fields, nodes: context.locatedNodes)
            try PrototypeMediaCaptions.validate(fields, nodes: context.locatedNodes)
            try PrototypeTimerValidator.validate(context.actions)
            try PrototypeStrictSemantics.vocabulary(context, data: modelData)
            try PrototypeLinkify.validate(root: root, nodes: context.locatedNodes)
            try PrototypeStrictSemantics.targets(context)
            try PrototypeTooltips.validate(nodes: context.locatedNodes, scopes: repeats.scopes)
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
            try PrototypeBarScroll.validate(expanded)
            try PrototypePagerOptions.validate(expanded)
            try PrototypeSwipe.validate(expanded)
            try PrototypeCarousel.validate(expanded)
            try PrototypeRefresh.validate(expanded)
            try PrototypeMenus.validate(expanded, state: state)
            if let supportedCapabilities,
               !PrototypeStrictCapabilities.required(fields).isSubset(of: supportedCapabilities)
            {
                let missing = PrototypeStrictCapabilities.required(fields).subtracting(supportedCapabilities)
                throw PrototypeContractValidator.invalid(
                    "$",
                    "Unsupported capabilities: \(PrototypeContractValidator.sorted(missing).joined(separator: ", "))"
                )
            }
            if let shareAssetIds {
                for action in context.actions
                    where action.value["type"] == .string("platform") && action.value["call"] == .string("share.open")
                {
                    if let error = PrototypeShare.argumentsError(
                        action.value["args"]?.objectFields ?? [:],
                        path: "\(action.path).args",
                        assets: shareAssetIds
                    ) {
                        throw PrototypeContractValidator.invalid(error.path, error.message)
                    }
                }
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
            if library {
                for id in (fields["channels"]?.objectFields ?? [:]).keys.sorted()
                    where fields["channels"]?.objectFields?[id]?.objectFields?["via"] != .string("device")
                {
                    throw PrototypeContractValidator.invalid(
                        "\(PrototypeLimits.dataMemberPath("channels", key: id)).via",
                        "Host requests are unavailable in a library"
                    )
                }
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
        for (id, raw) in fields["channels"]?.objectFields ?? [:] {
            guard let channel = raw.objectFields else { continue }
            let at = PrototypeLimits.dataMemberPath("channels", key: id)
            append(channel["url"], path: "\(at).url", request: true)
            for (name, value) in channel["headers"]?.objectFields ?? [:] {
                append(value, path: PrototypeLimits.dataMemberPath("\(at).headers", key: name), request: true)
            }
        }
        func shareStrings(_ raw: JSONValue, path: String) {
            switch raw {
            case let .string(text): bindings.append((text, path, false, false))
            case let .array(array): for (index, entry) in array.enumerated() {
                    shareStrings(
                        entry,
                        path: "\(path)[\(index)]"
                    )
                }
            case let .object(form): for (key, entry) in form {
                    shareStrings(
                        entry,
                        path: PrototypeLimits.dataMemberPath(path, key: key)
                    )
                }
            default: break
            }
        }
        for action in actions {
            if action.value["type"] == .string("platform"), action.value["call"] == .string("share.open") {
                for (name, binding) in action.value["args"]?.objectFields ?? [:] {
                    if let literal = binding
                        .objectFields?["value"] { shareStrings(literal, path: "\(action.path).args.\(name).value") }
                }
            }
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
                let body = action.value["body"]?.objectFields
                for (index, part) in PrototypeStrictBindings.array(body?["multipart"]).enumerated() {
                    append(
                        part.objectFields?["value"],
                        path: "\(action.path).body.multipart[\(index)].value",
                        request: true
                    )
                }
                for (name, binding) in body?["form"]?.objectFields ?? [:] {
                    append(
                        binding,
                        path: PrototypeLimits.dataMemberPath("\(action.path).body.form", key: name),
                        request: true
                    )
                }
                append(action.value["body"], path: "\(action.path).body", request: true)
            case "setData", "appendData", "prependData", "upsertData":
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
        let sinks = bindings.sorted(by: { $0.path.utf16.lexicographicallyPrecedes($1.path.utf16) })
        var expandedBytes = 0
        for binding in sinks {
            let scope = repeats.scopes.first { binding.path.hasPrefix("\($0.path).children[") }
            expandedBytes += binding.text.utf8.count * max(1, scope?.items.count ?? 1)
            if expandedBytes > 4_194_304 {
                throw PrototypeContractValidator.invalid(
                    binding.path,
                    "Secure binding scan exceeds 4194304 expanded UTF-8 bytes"
                )
            }
        }
        for binding in sinks {
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
