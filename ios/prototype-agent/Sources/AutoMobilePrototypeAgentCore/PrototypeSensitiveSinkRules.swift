import Foundation

/// Library-only R2 data flow, matching prototypeSensitiveSinkErrors (#15635).
/// Literal payloads stay opaque; request/channel wire fields and storage keys are sinks.
enum PrototypeSensitiveSinkRules {
    private struct Field {
        let text: String
        let path: String
        var pointerSource: String?
        var itemBinding = false
        var key = false
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
        scan(spec, nodes: nodes, actions: actions, repeats: repeats, validRepeats: validRepeats).errors
    }

    /// Counts sink index visits, excluding construction and copy propagation.
    /// A smaller check cap keeps exhaustion tests fast; production uses the shared 4,000,000 cap.
    static func scan(
        _ spec: [String: JSONValue], nodes: [PrototypeLocatedValue],
        actions: [PrototypeLocatedValue], repeats: PrototypeStrictRepeats, validRepeats: Bool = true,
        maxChecks: Int = 4_000_000
    )
        -> (errors: [PrototypeLoadError], checks: Int)
    {
        var checks = 0
        func visit() -> Bool {
            guard checks <= maxChecks else { return false }
            checks += 1
            return checks <= maxChecks
        }
        let seeds = sensitivePointers(spec)
        let declared = PrototypeStrictBindings.array(spec["requires"]?.objectFields?["platform"])
        let platformTaints = PrototypeContractValidator.platformModules.flatMap { module, raw in
            (raw.objectFields?["state"]?.objectFields ?? [:]).compactMap { key, entry -> String? in
                entry.objectFields?["sensitive"] == .bool(true) && declared.contains(.string(module)) ?
                    "/\(module)/\(key)" : nil
            }
        }
        guard !seeds.isEmpty || !platformTaints.isEmpty else { return ([], checks) }
        guard let taints = propagateCopies(
            seeds, platformTaints: platformTaints, nodes: nodes, actions: actions, maxChecks: maxChecks
        ) else {
            return (
                [.invalidSpec(path: "$", message: "Secure copy taint analysis exceeds 4000000 overlap checks")],
                checks
            )
        }
        let dataIndex = sinkOverlapIndex(taints.data, visit: visit)
        let platformIndex = sinkOverlapIndex(platformTaints, visit: visit)
        let stateIndex = stateKeyTaintIndex(taints.state, visit: visit)
        let sinks = sinkFields(spec, actions: actions, includeState: !taints.state.isEmpty).sorted {
            $0.path.utf16.lexicographicallyPrecedes($1.path.utf16)
        }
        if validRepeats, let error = expandedSinkLimitError(sinks, repeats: repeats) {
            return ([error], checks)
        }
        let taintedRows = nodes.compactMap { node -> (path: String, alias: String)? in
            let repeated = node.value["repeat"]?.objectFields
            guard let alias = repeated?["as"]?.stringValue,
                  let pointer = repeated?["items"]?.objectFields?["path"]?.stringValue,
                  PrototypeDataPointer.isValid(pointer),
                  dataIndex(pointer, false) else { return nil }
            return (node.path, alias)
        }
        var errors: [PrototypeLoadError] = []
        for field in sinks {
            if checks > maxChecks { break }
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
            func reaches(_ source: String, index: (String, Bool) -> Bool) -> Bool {
                let pointers = field.pointerSource == nil ? texts.flatMap {
                    source == "data" ? dataPlaceholders($0) : PrototypePlatformValidator.placeholders($0)
                } : (field.pointerSource == source ? [field.text] : [])
                return pointers.contains { index($0, field.pointerSource == nil) }
            }
            let readsState = field.key ? texts.contains(where: stateIndex.key) :
                field.pointerSource == nil && texts.contains(where: stateIndex.text)
            let reached = field.key ? readsState :
                rowRead || readsState || reaches("data", index: dataIndex) || reaches("platform", index: platformIndex)
            if reached {
                errors.append(.invalidSpec(
                    path: field.path,
                    message: field.path.hasPrefix("storage.keys[") ? "Sensitive value cannot be persisted" :
                        "Sensitive value cannot be bound into a request"
                ))
            }
        }
        if checks > maxChecks {
            return (
                [.invalidSpec(path: "$", message: "Secure copy taint analysis exceeds 4000000 overlap checks")],
                checks
            )
        }
        return (errors, checks)
    }

    private static func expandedSinkLimitError(_ sinks: [Field], repeats: PrototypeStrictRepeats)
        -> PrototypeLoadError?
    {
        var bytes = 0
        for field in sinks {
            let scope = repeats.scopes.first { field.path.hasPrefix("\($0.path).children[") }
            bytes += field.text.utf8.count * max(1, scope?.items.count ?? 1)
            if bytes > 4_194_304 {
                return .invalidSpec(
                    path: field.path,
                    message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes"
                )
            }
        }
        return nil
    }

    private final class TaintNode {
        var children: [[UInt16]: TaintNode] = [:]
        var terminal = false
        var hasTaintBelow = false
    }

    /// Existence index for overlaps' segment-prefix and {index} rules, with exact UTF-16 keys.
    private static func sinkOverlapIndex(_ taints: [String], visit: @escaping () -> Bool) -> (String, Bool) -> Bool {
        let root = TaintNode()
        let wildcard = Array("{index}".utf16)
        for taint in taints {
            var node = root
            node.hasTaintBelow = true
            for segment in pointerSegments(taint) {
                let child = node.children[segment] ?? TaintNode()
                node.children[segment] = child
                node = child
                node.hasTaintBelow = true
            }
            node.terminal = true
        }
        return { pointer, pointerIndexWildcard in
            let segments = pointerSegments(pointer)
            func walk(_ node: TaintNode, depth: Int) -> Bool {
                guard visit() else { return false }
                if node.terminal || depth == segments.count { return node.hasTaintBelow }
                let segment = segments[depth]
                if pointerIndexWildcard, segment == wildcard {
                    return node.children.values.contains { walk($0, depth: depth + 1) }
                }
                if let literal = node.children[segment], walk(literal, depth: depth + 1) { return true }
                if segment != wildcard, let child = node.children[wildcard] {
                    return walk(child, depth: depth + 1)
                }
                return false
            }
            return walk(root, depth: 0)
        }
    }

    private static func pointerSegments(_ pointer: String) -> [[UInt16]] {
        pointer.utf16.dropFirst().split(separator: 47, omittingEmptySubsequences: false).map { Array($0) }
    }

    private struct Copy {
        let into: String
        let intoState: Bool
        let source: String
        let from: String
    }

    /// Match TypeScript's literal UTF-16 prefix before the first repeat placeholder.
    private static func statePrefix(_ key: String) -> [UInt16]? {
        let units = Array(key.utf16)
        return units.firstIndex(of: 123).map { Array(units[..<$0]) }
    }

    private static func stateKeysOverlap(_ left: String, _ right: String) -> Bool {
        switch (statePrefix(left), statePrefix(right)) {
        case (nil, nil): left.utf16.elementsEqual(right.utf16)
        case let (nil, prefix?): left.utf16.starts(with: prefix)
        case let (prefix?, nil): right.utf16.starts(with: prefix)
        case let (left?, right?): left.starts(with: right) || right.starts(with: left)
        }
    }

    private static func stateKeyTaintIndex(_ taints: [String], visit: @escaping () -> Bool)
        -> (key: (String) -> Bool, text: (String) -> Bool)
    {
        let literal = Set(taints.filter { statePrefix($0) == nil }.map { Array($0.utf16) })
        let templated = taints.filter { statePrefix($0) != nil }
        return (
            key: { key in
                guard visit() else { return false }
                let isLiteral = statePrefix(key) == nil
                if isLiteral, literal.contains(Array(key.utf16)) { return true }
                return (isLiteral ? templated : taints).contains { visit() && stateKeysOverlap($0, key) }
            },
            text: { text in
                text.utf16.contains(123) && taints.contains { taint in
                    guard visit() else { return false }
                    let name = statePrefix(taint).map { String(decoding: $0, as: UTF16.self) } ?? "\(taint)}"
                    return text.range(of: "{\(name)", options: .literal) != nil
                }
            }
        )
    }

    /// Collect typed data reads and setState operands; literal value bindings stay opaque.
    private static func copies(nodes: [PrototypeLocatedValue], actions: [PrototypeLocatedValue]) -> [Copy] {
        let writes: Set<String> = ["setData", "appendData", "prependData", "upsertData"]
        return actions.flatMap { action -> [Copy] in
            let intoState = action.value["type"] == .string("setState")
            let into: String?
            if intoState {
                into = action.value["key"]?.stringValue
            } else {
                guard let type = action.value["type"]?.stringValue, writes.contains(type) else { return [] }
                into = action.value["path"]?.stringValue.flatMap(PrototypeDataWrite.pointer(ofPath:))
            }
            guard let into else { return [] }
            func copy(_ source: String, _ from: String) -> Copy {
                Copy(into: into, intoState: intoState, source: source, from: from)
            }
            let value = action.value["value"]
            let read = value?.objectFields
            if let from = read?["platform"]?.stringValue { return [copy("platform", from)] }
            if !intoState {
                for source in ["data", "state"] {
                    if let from = read?[source]?.stringValue { return [copy(source, from)] }
                }
            }
            let text = intoState ? value?.stringValue : nil
            var result = text.map {
                dataPlaceholders($0).map { copy("data", $0) } +
                    PrototypePlatformValidator.placeholders($0).map { copy("platform", $0) }
            } ?? []
            result += repeatCopies(
                nodes: nodes,
                action: action,
                text: text,
                readsItem: !intoState && read?["item"]?.stringValue != nil,
                into: into,
                intoState: intoState
            )
            return result
        }
    }

    private static func repeatCopies(
        nodes: [PrototypeLocatedValue], action: PrototypeLocatedValue, text: String?, readsItem: Bool,
        into: String, intoState: Bool
    )
        -> [Copy]
    {
        var result: [Copy] = []
        for node in nodes where action.path.hasPrefix("\(node.path).children[") {
            let repeated = node.value["repeat"]?.objectFields
            guard let alias = repeated?["as"]?.stringValue,
                  let from = repeated?["items"]?.objectFields?["path"]?.stringValue,
                  PrototypeDataPointer.isValid(from) else { continue }
            let rowText = text.map { text in
                PrototypeRepeat.segments(text, alias: alias).contains {
                    if case .field = $0 { return true }; return false
                }
            } ?? false
            if rowText || readsItem {
                result.append(Copy(into: into, intoState: intoState, source: "data", from: from))
            }
        }
        return result
    }

    /// Copies through data and state stay tainted transitively, even after clean writes.
    /// Bucketed source reads keep literal chains linear; nil fails closed at the check cap.
    private static func propagateCopies(
        _ seeds: [String], platformTaints: [String], nodes: [PrototypeLocatedValue], actions: [PrototypeLocatedValue],
        maxChecks: Int
    )
        -> (data: [String], state: [String])?
    {
        func firstSegment(_ pointer: String) -> [UInt16] {
            Array(pointer.utf16.dropFirst().split(separator: 47, maxSplits: 1, omittingEmptySubsequences: false)[0])
        }
        var taints = seeds
        var stateTaints: [String] = []
        var known = Set(seeds.map { Array($0.utf16) })
        var knownState: Set<[UInt16]> = []
        var queue = seeds.map { (state: false, at: $0) }
        func mark(_ copy: Copy) {
            let inserted = copy.intoState ? knownState.insert(Array(copy.into.utf16)).inserted :
                known.insert(Array(copy.into.utf16)).inserted
            if inserted {
                if copy.intoState { stateTaints.append(copy.into) } else { taints.append(copy.into) }
                queue.append((copy.intoState, copy.into))
            }
        }
        var checks = 0
        var dataBuckets: [[UInt16]: [Copy]] = [:]
        var stateBuckets: [[UInt16]: [Copy]] = [:]
        var templatedState: [Copy] = []
        for copy in copies(nodes: nodes, actions: actions) {
            switch copy.source {
            case "data": dataBuckets[firstSegment(copy.from), default: []].append(copy)
            case "state":
                if statePrefix(copy.from) != nil { templatedState.append(copy) }
                else { stateBuckets[Array(copy.from.utf16), default: []].append(copy) }
            default:
                checks += platformTaints.count
                if platformTaints.contains(where: { overlaps($0, copy.from, pointerIndexWildcard: false) }) {
                    mark(copy)
                }
            }
        }
        func drain(_ bucket: [Copy], hit: (Copy) -> Bool) -> [Copy] {
            checks += bucket.count
            return bucket.filter { copy in
                if hit(copy) { mark(copy); return false }
                return true
            }
        }
        func process(_ taint: (state: Bool, at: String)) {
            if taint.state {
                let names = statePrefix(taint.at) != nil ? Array(stateBuckets.keys) : [Array(taint.at.utf16)]
                for name in names {
                    stateBuckets[name] = drain(stateBuckets[name] ?? []) { stateKeysOverlap(taint.at, $0.from) }
                }
                templatedState = drain(templatedState) { stateKeysOverlap(taint.at, $0.from) }
            } else {
                let key = firstSegment(taint.at)
                // A leading {index} taint segment matches any source segment.
                for name in key == Array("{index}".utf16) ? Array(dataBuckets.keys) : [key] {
                    dataBuckets[name] = drain(dataBuckets[name] ?? []) {
                        overlaps(taint.at, $0.from, pointerIndexWildcard: false)
                    }
                }
            }
        }
        var cursor = 0
        while cursor < queue.count {
            let taint = queue[cursor]
            cursor += 1
            process(taint)
            if checks > maxChecks { return nil }
        }
        return checks > maxChecks ? nil : (taints, stateTaints)
    }

    private static func sinkFields(
        _ spec: [String: JSONValue], actions: [PrototypeLocatedValue], includeState: Bool
    )
        -> [Field]
    {
        var fields: [Field] = []
        func binding(_ raw: JSONValue?, path: String, text: Bool = false) {
            if text, let value = raw?.stringValue { fields.append(.init(text: value, path: path)) }
            guard let form = raw?.objectFields else { return }
            if let state = form["state"]?.stringValue {
                if includeState { fields.append(.init(text: state, path: "\(path).state", key: true)) }
                return
            }
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
            let actionPath = action.path
            binding(action.value["url"], path: "\(actionPath).url", text: true)
            entries(action.value["headers"], path: "\(actionPath).headers", text: true)
            entries(action.value["query"], path: "\(actionPath).query", text: true)
            let body = action.value["body"]?.objectFields
            if case let .array(parts)? = body?["multipart"] {
                for (index, part) in parts.enumerated() {
                    binding(part.objectFields?["value"], path: "\(actionPath).body.multipart[\(index)].value")
                }
            } else if body?["form"]?.objectFields != nil {
                entries(body?["form"], path: "\(actionPath).body.form", text: false)
            } else if body?["file"] == nil {
                binding(action.value["body"], path: "\(actionPath).body")
            }
        }
        for (id, raw) in spec["channels"]?.objectFields ?? [:] {
            let channelPath = PrototypeLimits.dataMemberPath("channels", key: id)
            binding(raw.objectFields?["url"], path: "\(channelPath).url", text: true)
            entries(raw.objectFields?["headers"], path: "\(channelPath).headers", text: true)
        }
        for (index, key) in PrototypeStrictBindings.array(spec["storage"]?.objectFields?["keys"]).enumerated() {
            if includeState, let key = key.stringValue, key.hasPrefix("state:") {
                fields.append(.init(text: String(key.dropFirst(6)), path: "storage.keys[\(index)]", key: true))
            }
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
        let left = pointerSegments(taint)
        let right = pointerSegments(pointer)
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
