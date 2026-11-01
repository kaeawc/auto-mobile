import Foundation

/// Library-only R2 data flow, matching prototypeSensitiveSinkErrors (#15635).
/// Literal payloads stay opaque; only request/channel wire fields are sinks.
enum PrototypeSensitiveSinkRules {
    private struct Field {
        let text: String
        let path: String
        var dataPointer = false
        var itemBinding = false
    }

    static func validate(
        _ spec: [String: JSONValue], nodes: [PrototypeLocatedValue],
        actions: [PrototypeLocatedValue], repeats: PrototypeStrictRepeats
    )
        throws
    {
        if let error = errors(spec, nodes: nodes, actions: actions, repeats: repeats).first { throw error }
    }

    static func errors(
        _ spec: [String: JSONValue], nodes: [PrototypeLocatedValue],
        actions: [PrototypeLocatedValue], repeats: PrototypeStrictRepeats, validRepeats: Bool = true
    )
        -> [PrototypeLoadError]
    {
        let taints = sensitivePointers(spec)
        guard !taints.isEmpty else { return [] }
        let sinks = sinkFields(spec, actions: actions).sorted {
            $0.path.utf16.lexicographicallyPrecedes($1.path.utf16)
        }
        if validRepeats {
            var bytes = 0
            for field in sinks {
                let scope = repeats.scopes.first { field.path.hasPrefix("\($0.path).children[") }
                bytes += field.text.utf8.count * max(1, scope?.items.count ?? 1)
                if bytes > 4_194_304 {
                    return [.invalidSpec(
                        path: field.path,
                        message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes"
                    )]
                }
            }
        }
        let taintedRows = nodes.compactMap { node -> (path: String, alias: String)? in
            let repeated = node.value["repeat"]?.objectFields
            guard let alias = repeated?["as"]?.stringValue,
                  let pointer = repeated?["items"]?.objectFields?["path"]?.stringValue,
                  PrototypeDataPointer.isValid(pointer),
                  taints.contains(where: { overlaps($0, pointer, pointerIndexWildcard: false) }) else { return nil }
            return (node.path, alias)
        }
        var errors: [PrototypeLoadError] = []
        for field in sinks {
            let rowRead = taintedRows.contains { scope in
                field.path.hasPrefix("\(scope.path).children[") &&
                    (field.itemBinding || (
                        !field.dataPointer && PrototypeRepeat.segments(
                            field.text,
                            alias: scope.alias
                        )
                        .contains { if case .field = $0 { return true }; return false }
                    ))
            }
            // Typed pointers are literal at runtime. Derived text has no host-side instance,
            // so bound()'s empty result falls back to the authored data placeholders.
            let texts: [String]
            if field.dataPointer || !validRepeats {
                texts = [field.text]
            } else {
                let bound = repeats.bound([.init(value: ["stateKey": .string(field.text)], path: field.path)])
                texts = bound.isEmpty ? [field.text] : bound.compactMap { $0.value["stateKey"]?.stringValue }
            }
            let pointers = field.dataPointer ? [field.text] : texts.flatMap(dataPlaceholders)
            if rowRead || pointers.contains(where: { pointer in
                taints.contains { overlaps($0, pointer, pointerIndexWildcard: !field.dataPointer) }
            }) {
                errors.append(.invalidSpec(path: field.path, message: "Sensitive value cannot be bound into a request"))
            }
        }
        return errors
    }

    private static func sinkFields(_ spec: [String: JSONValue], actions: [PrototypeLocatedValue]) -> [Field] {
        var fields: [Field] = []
        func binding(_ raw: JSONValue?, path: String, text: Bool = false) {
            if text, let value = raw?.stringValue { fields.append(.init(text: value, path: path)) }
            guard let form = raw?.objectFields, form["state"] == nil else { return }
            if let pointer = form["data"]?.stringValue {
                fields.append(.init(text: pointer, path: path, dataPointer: true))
            }
            if form["item"]?.stringValue != nil {
                fields.append(.init(text: "", path: path, itemBinding: true))
            }
        }
        func entries(_ raw: JSONValue?, path: String, text: Bool) {
            for (name, value) in raw?.objectFields ?? [:] {
                binding(value, path: PrototypeLimits.dataMemberPath(path, key: name), text: text)
            }
        }
        for action in actions where action.value["type"] == .string("request") {
            let at = action.path
            binding(action.value["url"], path: "\(at).url", text: true)
            entries(action.value["headers"], path: "\(at).headers", text: true)
            entries(action.value["query"], path: "\(at).query", text: true)
            let body = action.value["body"]?.objectFields
            if case let .array(parts)? = body?["multipart"] {
                for (index, part) in parts.enumerated() {
                    binding(part.objectFields?["value"], path: "\(at).body.multipart[\(index)].value")
                }
            } else if body?["form"]?.objectFields != nil {
                entries(body?["form"], path: "\(at).body.form", text: false)
            } else if body?["file"] == nil {
                binding(action.value["body"], path: "\(at).body")
            }
        }
        for (id, raw) in spec["channels"]?.objectFields ?? [:] {
            let at = PrototypeLimits.dataMemberPath("channels", key: id)
            binding(raw.objectFields?["url"], path: "\(at).url", text: true)
            entries(raw.objectFields?["headers"], path: "\(at).headers", text: true)
        }
        return fields
    }

    private static func sensitivePointers(_ spec: [String: JSONValue]) -> [String] {
        var result: [String] = []
        func scan(_ value: JSONValue) {
            switch value {
            case let .array(values): values.forEach(scan)
            case let .object(fields):
                if fields.count == 1, fields["value"] != nil { return }
                let call = fields["type"] == .string("pasteButton") ? "clipboard.paste" :
                    (fields["type"] == .string("platform") ? fields["call"]?.stringValue : nil)
                if let call, let dot = call.firstIndex(of: "."),
                   PrototypeContractValidator.platformModules[String(call[..<dot])]?.objectFields?["calls"]?
                   .objectFields?[String(call[call.index(after: dot)...])]?.objectFields?["sensitive"] == .bool(true),
                   let into = fields["into"]?.stringValue, let pointer = PrototypeDataWrite.pointer(ofPath: into)
                {
                    result.append(pointer)
                }
                for (name, child) in fields where name != "repeat" && name != "payload" { scan(child) }
            default: break
            }
        }
        if let root = spec["root"] { scan(root) }
        for component in spec["components"]?.objectFields?.values ?? [:].values {
            if let root = component.objectFields?["root"] { scan(root) }
        }
        if let handlers = spec["platform"]?.objectFields?["on"] { scan(handlers) }
        for (handler, _) in PrototypeChannels.handlers(spec["channels"]?.objectFields ?? [:]) { scan(handler) }
        return result
    }

    private static func overlaps(_ taint: String, _ pointer: String, pointerIndexWildcard: Bool) -> Bool {
        let left = taint.utf16.dropFirst().split(separator: 47, omittingEmptySubsequences: false)
        let right = pointer.utf16.dropFirst().split(separator: 47, omittingEmptySubsequences: false)
        let wildcard = Array("{index}".utf16)
        return zip(left, right).allSatisfy {
            $0.elementsEqual($1) || $0.elementsEqual(wildcard) || (pointerIndexWildcard && $1.elementsEqual(wildcard))
        }
    }

    /// Use the existing platform placeholder scanner's identical pointer grammar. Only data
    /// candidates are passed to it, so authored platform reads cannot become data taints.
    private static func dataPlaceholders(_ text: String) -> [String] {
        var result: [String] = []
        var cursor = text.startIndex
        while let open = text.range(of: "{data:", options: .literal, range: cursor ..< text.endIndex) {
            let suffix = String(
                decoding: text.utf16[open.upperBound...]
                    .prefix(PrototypeLimits.maxDataPointerLength + 1),
                as: UTF16.self
            )
            if let close = suffix.range(of: "}", options: .literal) {
                let candidate = String(suffix[..<close.lowerBound])
                if PrototypeDataPointer.isValid(candidate) {
                    result += PrototypePlatformValidator.placeholders("{platform:\(candidate)}")
                }
            }
            cursor = open.upperBound
        }
        return result
    }
}
