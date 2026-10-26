import Foundation

/// Backstop for the structural limits the host validator enforces, mirroring Android's
/// `guardPrototypeTree`. A spec that reaches the agent without the host check (a direct client)
/// cannot exhaust it: the tree is bounded before `repeat` expansion allocates anything.
///
/// The constants repeat `schemas/prototype-spec-contract.json` (the data and list limits read it
/// directly); `PrototypeLimitsTests` fails when any of them drifts from it.
enum PrototypeLimits {
    static let maxStackScreens = 32
    static let maxStackDepth = 32
    static let maxEmitContextEntries = 16
    static let maxEmitPayloadBytes = 4096
    static let maxEmitPayloadDepth = 24
    static let maxPatchOps = 64
    static let maxNodes = 2000
    static let maxDepth = 24
    static let maxTextSpans = 64
    static let maxRepeatItems = 128
    static let maxListItems = PrototypeContractValidator.limit("MAX_PROTOTYPE_LIST_ITEMS")
    static let maxRepeatPathCells = 65536
    static let maxSubstitutedTextLength = 16384
    static let maxSubstitutedTextTotal = 4_194_304
    /// `MAX_PROTOTYPE_SPEC_BYTES`: the UTF-8 size of the whole spec, current state included. Android
    /// re-checks it on every state write; see `PrototypeStateValidator.specBytes`.
    static let maxSpecBytes = 1_048_576

    static let maxDataDepth = 8
    static let maxDataArrayItems = PrototypeContractValidator.limit("MAX_PROTOTYPE_DATA_ARRAY_ITEMS")
    static let maxDataPointerLength = 256
    static let maxDataBytes = PrototypeContractValidator.limit("MAX_PROTOTYPE_DATA_BYTES")
    /// `MAX_PROTOTYPE_STORAGE_BYTES` (#12522): stored bytes per prototype id, summed over entries as
    /// the UTF-8 length of the storage key plus the compact JSON of the value.
    static let maxStorageBytes = 262_144
    /// `MAX_PROTOTYPE_STORAGE_KEYS`: entries in the spec's `storage.keys`.
    static let maxStorageKeys = 64
    /// `MAX_PROTOTYPE_DATA_WRITE_BYTES`: the host validator's byte cost of `data` after a device
    /// `setData`, `appendData`, `prependData` or `removeData` write.
    static let maxDataWriteBytes = PrototypeContractValidator.limit("MAX_PROTOTYPE_DATA_WRITE_BYTES")

    /// Agent-side depth/array backstop, in the host's sorted UTF-16 member order. Data is depth 1.
    /// The host's byte-cost rule is not duplicated: there is no Swift validator twin, and the
    /// existing 1 MiB whole-spec byte cap still bounds the input.
    static func guardData(_ data: [String: JSONValue]) throws {
        try visitData(.object(data), path: "data", depth: 1)
    }

    private static func visitDataArray(_ items: [JSONValue], path: String, depth: Int) throws {
        if depth > maxDataDepth { throw violation(path, "Data depth limit exceeded") }
        if items.count > maxDataArrayItems { throw violation(path, "Data array limit exceeded") }
        for (index, member) in items.enumerated() {
            try visitData(member, path: "\(path)[\(index)]", depth: depth + 1)
        }
    }

    private static func visitData(_ value: JSONValue, path: String, depth: Int) throws {
        switch value {
        case let .object(fields):
            if depth > maxDataDepth { throw violation(path, "Data depth limit exceeded") }
            for key in fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if let member = fields[key] {
                    try visitData(member, path: dataMemberPath(path, key: key), depth: depth + 1)
                }
            }
        case let .array(items):
            try visitDataArray(items, path: path, depth: depth)
        case let .number(number):
            if !number.isFinite { throw violation(path, "Invalid data value") }
        case .null: throw violation(path, "Invalid data value")
        case .string, .bool: break
        }
    }

    /// The data after a device write must satisfy the data depth and array limits and the byte cost
    /// `maxDataWriteBytes`, as `prototypeDataError` does on the host. Unlike `guardData`, bytes are
    /// counted here because a write grows data after the show's own size check.
    static func guardDataWrite(_ data: [String: JSONValue]) throws {
        try guardData(data)
        if dataByteCost(.object(data), depth: 0) > maxDataWriteBytes {
            throw violation("data", "Data byte limit exceeded")
        }
    }

    /// The host's `jsonCost`: numbers cost 32, strings and booleans their JSON text, containers
    /// their separators plus members. Nesting past the emit payload depth costs everything.
    static func dataByteCost(_ value: JSONValue, depth: Int) -> Int {
        guard depth <= maxEmitPayloadDepth else { return .max }
        switch value {
        case .null: return 4
        case .number: return 32
        case let .bool(flag): return flag ? 4 : 5
        case let .string(text): return PrototypeEmitContext.quotedByteCount(text) ?? .max
        case let .array(items):
            return saturatingSum(2 + max(0, items.count - 1), items.map { dataByteCost($0, depth: depth + 1) })
        case let .object(fields):
            let members = fields.map { key, member -> Int in
                let keyCost = PrototypeEmitContext.quotedByteCount(key) ?? .max
                return keyCost == .max ? .max : saturatingSum(keyCost + 1, [dataByteCost(member, depth: depth + 1)])
            }
            return saturatingSum(2 + max(0, fields.count - 1), members)
        }
    }

    private static func saturatingSum(_ base: Int, _ parts: [Int]) -> Int {
        parts.reduce(base) { total, part in
            part == .max || total == .max ? .max : total + part
        }
    }

    static func dataMemberPath(_ path: String, key: String) -> String {
        if PrototypeContractValidator.matches("pathKey", key) {
            return "\(path).\(key)"
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        // Encoding a Swift string cannot fail; retaining a fallback keeps this path total.
        let encoded = (try? encoder.encode(key)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        return "\(path)[\(encoded)]"
    }

    /// Throws the first limit the tree breaks. `repeat` templates count once per instance, in the
    /// same traversal order and path spelling as the Android guard (`root.repeat[1].children[0]`).
    static func guardTree(_ root: JSONValue) throws {
        var expandedCount = 0
        try visit(root, path: "root", depth: 1, authored: false, count: &expandedCount)
    }

    /// Known nonempty literal instances use the expanded budget. Unknown or empty templates use
    /// an independent authored budget, visited once even inside a literal repeat's instances.
    static func guardAuthoredTree(_ root: JSONValue) throws {
        try guardObjectChildren(root, path: "root", depth: 1)
        var expandedCount = 0
        try visit(root, path: "root", depth: 1, authored: true, count: &expandedCount)
        var authoredTemplateCount = 0
        try visitAuthoredTemplates(root, path: "root", depth: 1, template: false, count: &authoredTemplateCount)
    }

    /// Runs after guardAuthoredTree has depth-checked every subtree the cell guard and resolver
    /// traverse. Counts containers in pre-order, including childless templates; missing or
    /// non-array pointers contribute no cells. The explicit depth check also bounds direct calls.
    static func guardRepeatPathCells(_ root: JSONValue, data: [String: JSONValue]?) throws {
        var repeats = PrototypeRepeatData(data: data)
        var total = 0
        func visitCells(_ node: JSONValue, path: String, depth: Int) throws {
            guard case let .object(fields) = node else { return }
            if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
            if case let .object(spec)? = fields["repeat"],
               case let .object(source)? = spec["items"], let pointer = source["path"]?.stringValue
            {
                total += repeats.cells(pointer)
                if total > maxRepeatPathCells {
                    throw violation("\(path).repeat.items.path", "Repeat path cell limit exceeded")
                }
            }
            for name in ["header", "footer"] {
                if let child = fields[name] { try visitCells(child, path: "\(path).\(name)", depth: depth + 1) }
            }
            if let child = fields["child"] {
                try visitCells(child, path: "\(path).child", depth: depth + 1)
            } else if case let .array(children)? = fields["children"] {
                for (index, child) in children.enumerated() {
                    try visitCells(child, path: "\(path).children[\(index)]", depth: depth + 1)
                }
            }
            if case let .object(screens)? = fields["screens"] {
                for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                    if let screen = screens[name] {
                        try visitCells(screen, path: PrototypeStacks.screenPath(path, name: name), depth: depth + 1)
                    }
                }
            }
        }
        try visitCells(root, path: "root", depth: 1)
    }

    /// Checks authored edges once, leaving depth and node errors to the existing visits.
    private static func guardObjectChildren(_ node: JSONValue, path: String, depth: Int) throws {
        guard depth <= maxDepth, case let .object(fields) = node else { return }
        func child(_ value: JSONValue, at childPath: String) throws {
            guard case .object = value else { throw violation(childPath, "Expected object") }
            guard depth < maxDepth else { return }
            try guardObjectChildren(value, path: childPath, depth: depth + 1)
        }
        for name in ["child", "header", "footer"] {
            if let value = fields[name] { try child(value, at: "\(path).\(name)") }
        }
        if case let .array(children)? = fields["children"] {
            for (index, value) in children.enumerated() {
                try child(value, at: "\(path).children[\(index)]")
            }
        }
        if case let .object(screens)? = fields["screens"] {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if let screen = screens[name] {
                    try child(screen, at: PrototypeStacks.screenPath(path, name: name))
                }
            }
        }
    }

    private static func visitScreens(
        _ fields: [String: JSONValue],
        path: String,
        depth: Int,
        authored: Bool,
        count: inout Int
    )
        throws
    {
        if case let .object(screens)? = fields["screens"] {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if let screen = screens[name] {
                    try visit(
                        screen,
                        path: PrototypeStacks.screenPath(path, name: name),
                        depth: depth + 1,
                        authored: authored,
                        count: &count
                    )
                }
            }
        }
    }

    private static func visit(
        _ node: JSONValue, path: String, depth: Int, authored: Bool, count: inout Int
    )
        throws
    {
        guard case let .object(fields) = node else { return }
        try guardCheckLimits(.object(fields), path: path)
        count += 1
        if count > maxNodes { throw violation(path, "Node limit exceeded") }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if authored { try guardTextSpans(fields, path: path) }
        if authored, hasUncountedTemplate(fields) { return }
        if case let .array(children)? = fields["children"] {
            if case let .object(spec)? = fields["repeat"], fields["type"] != .string("list") {
                try visitLiteralChildren(
                    spec, children: children, path: path, depth: depth, authored: authored, count: &count
                )
            } else {
                for (index, child) in children.enumerated() {
                    try visit(
                        child, path: "\(path).children[\(index)]", depth: depth + 1, authored: authored, count: &count
                    )
                }
            }
        }
        for name in ["child", "header", "footer"] {
            if let child = fields[name] { try visit(
                child,
                path: "\(path).\(name)",
                depth: depth + 1,
                authored: authored,
                count: &count
            ) }
        }
        try visitScreens(fields, path: path, depth: depth, authored: authored, count: &count)
    }

    private static func visitLiteralChildren(
        _ spec: [String: JSONValue], children: [JSONValue], path: String, depth: Int,
        authored: Bool, count: inout Int
    )
        throws
    {
        guard case let .array(items)? = spec["items"] else { return }
        if items.count > maxRepeatItems { throw violation("\(path).repeat.items", "Repeat item limit exceeded") }
        for item in items.indices {
            for (index, child) in children.enumerated() {
                try visit(
                    child,
                    path: "\(path).repeat[\(item)].children[\(index)]",
                    depth: depth + 1,
                    authored: authored,
                    count: &count
                )
            }
        }
    }

    private static func hasUncountedTemplate(_ fields: [String: JSONValue]) -> Bool {
        if fields["type"] == .string("list") { return false }
        guard case let .object(spec)? = fields["repeat"] else { return false }
        guard case let .array(items)? = spec["items"] else { return true }
        return items.isEmpty
    }

    private static func visitAuthoredScreens(
        _ fields: [String: JSONValue],
        path: String,
        depth: Int,
        childTemplate: Bool,
        count: inout Int,
        insideRepeat: Bool
    )
        throws
    {
        if case let .object(screens)? = fields["screens"] {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if let screen = screens[name] {
                    try visitAuthoredTemplates(
                        screen, path: PrototypeStacks.screenPath(path, name: name), depth: depth + 1,
                        template: childTemplate, count: &count, insideRepeat: insideRepeat || fields["repeat"] != nil
                    )
                }
            }
        }
    }

    /// Structural traversal, never instance expansion: all descendants of an uncounted template
    /// consume this budget once, including nested repeats and single-child nodes.
    private static func visitAuthoredTemplates(
        _ node: JSONValue, path: String, depth: Int, template: Bool, count: inout Int, insideRepeat: Bool = false
    )
        throws
    {
        guard case let .object(fields) = node else { return }
        try guardCheckLimits(.object(fields), path: path)
        if template {
            count += 1
            if count > maxNodes { throw violation(path, "Node limit exceeded") }
        }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if template { try guardTextSpans(fields, path: path) }
        if insideRepeat, fields["type"]?.stringValue == "stack" {
            throw violation(path, "Stack cannot appear inside a repeat template")
        }
        let childTemplate = template || hasUncountedTemplate(fields)
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try visitAuthoredTemplates(
                    child, path: "\(path).children[\(index)]", depth: depth + 1,
                    template: childTemplate, count: &count, insideRepeat: insideRepeat || fields["repeat"] != nil
                )
            }
        }
        if let child = fields["child"] {
            try visitAuthoredTemplates(
                child, path: "\(path).child", depth: depth + 1, template: childTemplate, count: &count,
                insideRepeat: insideRepeat || fields["repeat"] != nil
            )
        }
        for name in ["header", "footer"] {
            if let child = fields[name] {
                try visitAuthoredTemplates(
                    child,
                    path: "\(path).\(name)",
                    depth: depth + 1,
                    template: childTemplate,
                    count: &count,
                    insideRepeat: insideRepeat
                )
            }
        }
        try visitAuthoredScreens(
            fields,
            path: path,
            depth: depth,
            childTemplate: childTemplate,
            count: &count,
            insideRepeat: insideRepeat
        )
    }

    /// Validate authored spans before data/repeat substitution (which may legitimately yield empty text).
    private static func guardTextSpans(_ fields: [String: JSONValue], path: String) throws {
        guard fields["type"] == .string("text") else { return }
        let hasText = fields["text"] != nil
        let hasSpans = fields["spans"] != nil
        if hasText == hasSpans {
            throw violation(
                "\(path).\(hasSpans ? "spans" : "text")",
                hasSpans ? "text and spans cannot both be set" : "text node needs text or spans"
            )
        }
        guard hasSpans else {
            if fields["text"] == .null { throw violation("\(path).text", "Invalid string value") }
            return
        }
        guard case let .array(spans)? = fields["spans"] else {
            throw violation("\(path).spans", "Expected array")
        }
        if spans.count > maxTextSpans { throw violation("\(path).spans", "Text span limit exceeded") }
        if spans.isEmpty { throw violation("\(path).spans", "Array length out of range") }
        for (index, span) in spans.enumerated() {
            if case let .object(member) = span, member["text"] == .string("") {
                throw violation("\(path).spans[\(index)].text", "Invalid string value")
            }
        }
    }

    /// Checks are host-validated. Re-check resource limits, not the host's schema or grammar.
    private static func guardCheckLimits(_ node: JSONValue, path: String) throws {
        guard case let .object(fields) = node else { return }
        if case let .array(checks)? = fields["checks"] {
            if checks.count > 8 { throw violation("\(path).checks", "Check limit exceeded") }
            for check in checks {
                if case let .object(rule) = check, let pattern = rule["pattern"]?.stringValue,
                   !PrototypeCheckPattern.withinLimits(pattern)
                {
                    throw violation("\(path).checks", "Pattern limit exceeded")
                }
            }
        }
        // Walk only condition/action fields here; children have the existing bounded tree walk.
        func guardReferences(_ value: JSONValue) throws {
            switch value {
            case let .object(object):
                for key in ["valid", "requireValid"] {
                    if case let .array(keys)? = object[key], keys.count > 8 {
                        throw violation(path, "Validity key limit exceeded")
                    }
                }
                for key in [
                    "all",
                    "any",
                    "not",
                    "when",
                    "onTap",
                    "actions",
                    "navigationIcon",
                    "confirm",
                    "dismiss",
                    "action",
                ] {
                    if let child = object[key] { try guardReferences(child) }
                }
            case let .array(values): for child in values {
                    try guardReferences(child)
                }
            default: break
            }
        }
        for key in [
            "visibleWhen",
            "enabledWhen",
            "styleWhen",
            "onTap",
            "actions",
            "navigationIcon",
            "confirm",
            "dismiss",
            "action",
        ] {
            if let value = fields[key] { try guardReferences(value) }
        }
    }

    static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }
}
