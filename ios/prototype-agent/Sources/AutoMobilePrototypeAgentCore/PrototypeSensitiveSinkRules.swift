import Foundation

/// Library-only R2 data flow, matching prototypeSensitiveSinkErrors (#15635).
/// Literal payloads stay opaque; request/channel wire fields and storage keys are sinks.
enum PrototypeSensitiveSinkRules {
    private struct Field {
        let text: String
        let path: String
        var pointerSource: String?
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
        let seeds = sensitivePointers(spec)
        let declared = PrototypeStrictBindings.array(spec["requires"]?.objectFields?["platform"])
        let platformTaints = PrototypeContractValidator.platformModules.flatMap { module, raw in
            (raw.objectFields?["state"]?.objectFields ?? [:]).compactMap { key, entry -> String? in
                entry.objectFields?["sensitive"] == .bool(true) && declared.contains(.string(module)) ?
                    "/\(module)/\(key)" : nil
            }
        }
        guard !seeds.isEmpty || !platformTaints.isEmpty else { return [] }
        guard let taints = propagateCopies(seeds, platformTaints: platformTaints, actions: actions) else {
            return [.invalidSpec(path: "$", message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes")]
        }
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
                        field.pointerSource == nil && PrototypeRepeat.segments(
                            field.text,
                            alias: scope.alias
                        )
                        .contains { if case .field = $0 { return true }; return false }
                    ))
            }
            // Typed pointers are literal at runtime. Derived text has no host-side instance,
            // so bound()'s empty result falls back to the authored data placeholders.
            let texts: [String]
            if field.pointerSource != nil || !validRepeats {
                texts = [field.text]
            } else {
                let bound = repeats.bound([.init(value: ["stateKey": .string(field.text)], path: field.path)])
                texts = bound.isEmpty ? [field.text] : bound.compactMap { $0.value["stateKey"]?.stringValue }
            }
            func reaches(_ source: String, taints: [String]) -> Bool {
                let pointers = field.pointerSource == nil ? texts.flatMap {
                    source == "data" ? dataPlaceholders($0) : PrototypePlatformValidator.placeholders($0)
                } : (field.pointerSource == source ? [field.text] : [])
                return pointers.contains { pointer in
                    taints.contains { overlaps($0, pointer, pointerIndexWildcard: field.pointerSource == nil) }
                }
            }
            if rowRead || reaches("data", taints: taints) || reaches("platform", taints: platformTaints) {
                errors.append(.invalidSpec(
                    path: field.path,
                    message: field.path.hasPrefix("storage.keys[") ? "Sensitive value cannot be persisted" :
                        "Sensitive value cannot be bound into a request"
                ))
            }
        }
        return errors
    }

    /// A data action copying a tainted read into `/data` taints its destination, transitively. A
    /// worklist over copies bucketed by their source's first segment keeps long chains linear;
    /// nil means the check cap was exceeded, so callers fail closed.
    private static func propagateCopies(
        _ seeds: [String], platformTaints: [String], actions: [PrototypeLocatedValue]
    )
        -> [String]?
    {
        let writes: Set<String> = ["setData", "appendData", "prependData", "upsertData"]
        let copies = actions.compactMap { action -> (into: String, source: String, from: String)? in
            guard let type = action.value["type"]?.stringValue, writes.contains(type),
                  let into = action.value["path"]?.stringValue.flatMap(PrototypeDataWrite.pointer(ofPath:)),
                  let read = action.value["value"]?.objectFields else { return nil }
            for source in ["data", "platform"] {
                if let from = read[source]?.stringValue { return (into, source, from) }
            }
            return nil
        }
        func firstSegment(_ pointer: String) -> String {
            String(pointer.dropFirst().split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)[0])
        }
        var taints = seeds
        var known = Set(seeds)
        var queue = seeds
        func mark(_ pointer: String) {
            if known.insert(pointer).inserted {
                taints.append(pointer)
                queue.append(pointer)
            }
        }
        var checks = 0
        var buckets: [String: [(into: String, from: String)]] = [:]
        for copy in copies {
            if copy.source == "data" {
                buckets[firstSegment(copy.from), default: []].append((copy.into, copy.from))
            } else {
                checks += platformTaints.count
                if platformTaints.contains(where: { overlaps($0, copy.from, pointerIndexWildcard: false) }) {
                    mark(copy.into)
                }
            }
        }
        var cursor = 0
        while cursor < queue.count {
            let taint = queue[cursor]
            cursor += 1
            let key = firstSegment(taint)
            // A leading {index} taint segment matches any source segment.
            for name in key == "{index}" ? Array(buckets.keys) : [key] {
                var rest: [(into: String, from: String)] = []
                for copy in buckets[name] ?? [] {
                    checks += 1
                    if overlaps(taint, copy.from, pointerIndexWildcard: false) {
                        mark(copy.into)
                    } else {
                        rest.append(copy)
                    }
                }
                buckets[name] = rest
            }
            if checks > 4_000_000 { return nil }
        }
        return checks > 4_000_000 ? nil : taints
    }

    private static func sinkFields(_ spec: [String: JSONValue], actions: [PrototypeLocatedValue]) -> [Field] {
        var fields: [Field] = []
        func binding(_ raw: JSONValue?, path: String, text: Bool = false) {
            if text, let value = raw?.stringValue { fields.append(.init(text: value, path: path)) }
            guard let form = raw?.objectFields, form["state"] == nil else { return }
            for source in ["data", "platform"] {
                if let pointer = form[source]?.stringValue {
                    fields.append(.init(text: pointer, path: path, pointerSource: source))
                }
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
        for (index, key) in PrototypeStrictBindings.array(spec["storage"]?.objectFields?["keys"]).enumerated() {
            if let key = key.stringValue, key.hasPrefix("data:"),
               PrototypeDataPointer.isValid(String(key.dropFirst(5)))
            {
                fields.append(.init(
                    text: String(key.dropFirst(5)),
                    path: "storage.keys[\(index)]",
                    pointerSource: "data"
                ))
            }
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
            let suffix = text.utf16[open.upperBound...]
                .prefix(PrototypeLimits.maxDataPointerLength + 1)
            if let close = suffix.firstIndex(of: 125) {
                let candidate = String(decoding: suffix[..<close], as: UTF16.self)
                if PrototypeDataPointer.isValid(candidate) {
                    result += PrototypePlatformValidator.placeholders("{platform:\(candidate)}")
                    cursor = text.utf16.index(after: close)
                    continue
                }
            }
            cursor = open.upperBound
        }
        return result
    }
}
