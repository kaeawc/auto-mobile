import Foundation

/// Backstop for the structural limits the host validator enforces, mirroring Android's
/// `guardPrototypeTree`. A spec that reaches the agent without the host check (a direct client)
/// cannot exhaust it: the tree is bounded before `repeat` expansion allocates anything.
///
/// The constants repeat `schemas/prototype-spec-contract.json`; `PrototypeLimitsTests` fails when they
/// drift from it.
enum PrototypeLimits {
    static let maxPatchOps = 64
    static let maxNodes = 2000
    static let maxDepth = 24
    static let maxTextSpans = 64
    static let maxRepeatItems = 128
    static let maxRepeatPathCells = 65536
    static let maxSubstitutedTextLength = 16384
    static let maxSubstitutedTextTotal = 4_194_304
    /// `MAX_PROTOTYPE_SPEC_BYTES`: the UTF-8 size of the whole spec, current state included. Android
    /// re-checks it on every state write; see `PrototypeStateValidator.specBytes`.
    static let maxSpecBytes = 1_048_576

    static let maxDataDepth = 8
    static let maxDataArrayItems = 500
    static let maxDataPointerLength = 256
    static let maxDataBytes = 262_144

    /// Agent-side depth/array backstop, in the host's sorted UTF-16 member order. Data is depth 1.
    /// The host's byte-cost rule is not duplicated: there is no Swift validator twin, and the
    /// existing 1 MiB whole-spec byte cap still bounds the input.
    static func guardData(_ data: [String: JSONValue]) throws {
        try visitData(.object(data), path: "data", depth: 1)
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
            if depth > maxDataDepth { throw violation(path, "Data depth limit exceeded") }
            if items.count > maxDataArrayItems { throw violation(path, "Data array limit exceeded") }
            for (index, member) in items.enumerated() {
                try visitData(member, path: "\(path)[\(index)]", depth: depth + 1)
            }
        case let .number(number):
            if !number.isFinite { throw violation(path, "Invalid data value") }
        case .null: throw violation(path, "Invalid data value")
        case .string, .bool: break
        }
    }

    private static func dataMemberPath(_ path: String, key: String) -> String {
        let scalars = key.unicodeScalars
        func initial(_ scalar: Unicode.Scalar) -> Bool {
            ("A" ... "Z").contains(scalar) || ("a" ... "z").contains(scalar) || scalar == "_"
        }
        if let first = scalars.first, initial(first),
           scalars.allSatisfy({ initial($0) || ("0" ... "9").contains($0) })
        {
            return "\(path).\(key)"
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        // Encoding a Swift string cannot fail; retaining a fallback keeps this path total.
        let encoded = (try? encoder.encode(key)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
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
            if let child = fields["child"] {
                try visitCells(child, path: "\(path).child", depth: depth + 1)
            } else if case let .array(children)? = fields["children"] {
                for (index, child) in children.enumerated() {
                    try visitCells(child, path: "\(path).children[\(index)]", depth: depth + 1)
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
        if let value = fields["child"] { try child(value, at: "\(path).child") }
        if case let .array(children)? = fields["children"] {
            for (index, value) in children.enumerated() {
                try child(value, at: "\(path).children[\(index)]")
            }
        }
    }

    private static func visit(
        _ node: JSONValue, path: String, depth: Int, authored: Bool, count: inout Int
    )
        throws
    {
        guard case let .object(fields) = node else { return }
        count += 1
        if count > maxNodes { throw violation(path, "Node limit exceeded") }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if authored { try guardTextSpans(fields, path: path) }
        if authored, hasUncountedTemplate(fields) { return }
        if case let .array(children)? = fields["children"] {
            if case let .object(spec)? = fields["repeat"] {
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
        if let child = fields["child"] {
            try visit(child, path: "\(path).child", depth: depth + 1, authored: authored, count: &count)
        }
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
        guard case let .object(spec)? = fields["repeat"] else { return false }
        guard case let .array(items)? = spec["items"] else { return true }
        return items.isEmpty
    }

    /// Structural traversal, never instance expansion: all descendants of an uncounted template
    /// consume this budget once, including nested repeats and single-child nodes.
    private static func visitAuthoredTemplates(
        _ node: JSONValue, path: String, depth: Int, template: Bool, count: inout Int
    )
        throws
    {
        guard case let .object(fields) = node else { return }
        if template {
            count += 1
            if count > maxNodes { throw violation(path, "Node limit exceeded") }
        }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if template { try guardTextSpans(fields, path: path) }
        let childTemplate = template || hasUncountedTemplate(fields)
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try visitAuthoredTemplates(
                    child, path: "\(path).children[\(index)]", depth: depth + 1,
                    template: childTemplate, count: &count
                )
            }
        }
        if let child = fields["child"] {
            try visitAuthoredTemplates(
                child, path: "\(path).child", depth: depth + 1, template: childTemplate, count: &count
            )
        }
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

    static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }
}
