import Foundation

/// Backstop for the structural limits the host validator enforces, mirroring Android's
/// `guardPrototypeTree`. A spec that reaches the agent without the host check (a direct client)
/// cannot exhaust it: the tree is bounded before `repeat` expansion allocates anything.
///
/// The constants repeat `schemas/prototype-spec-contract.json`; `PrototypeLimitsTests` fails when they
/// drift from it.
enum PrototypeLimits {
    static let maxNodes = 2000
    static let maxDepth = 24
    static let maxRepeatItems = 128
    static let maxRepeatPathCells = 65536
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
        var count = 0
        try visit(root, path: "root", depth: 1, count: &count)
    }

    /// Runs only after guardTree has bounded the authored depth. Counts containers in pre-order,
    /// including childless templates; missing or non-array pointers contribute no cells.
    static func guardRepeatPathCells(_ root: JSONValue, data: [String: JSONValue]?) throws {
        var repeats = PrototypeRepeatData(data: data)
        var total = 0
        func visitCells(_ node: JSONValue, path: String) throws {
            guard case let .object(fields) = node else { return }
            if case let .object(spec)? = fields["repeat"],
               case let .object(source)? = spec["items"], let pointer = source["path"]?.stringValue
            {
                total += repeats.cells(pointer)
                if total > maxRepeatPathCells {
                    throw violation("\(path).repeat.items.path", "Repeat path cell limit exceeded")
                }
            }
            if let child = fields["child"] {
                try visitCells(child, path: "\(path).child")
            } else if case let .array(children)? = fields["children"] {
                for (index, child) in children.enumerated() {
                    try visitCells(child, path: "\(path).children[\(index)]")
                }
            }
        }
        try visitCells(root, path: "root")
    }

    private static func visit(_ node: JSONValue, path: String, depth: Int, count: inout Int) throws {
        guard case let .object(fields) = node else { return }
        count += 1
        if count > maxNodes { throw violation(path, "Node limit exceeded") }
        if depth > maxDepth { throw violation(path, "Tree depth limit exceeded") }
        if case let .array(children)? = fields["children"] {
            if case let .object(spec)? = fields["repeat"] {
                if case .object? = spec["items"] {
                    for (index, child) in children.enumerated() {
                        try visit(child, path: "\(path).children[\(index)]", depth: depth + 1, count: &count)
                    }
                } else {
                    try visitLiteralChildren(spec, children: children, path: path, depth: depth, count: &count)
                }
            } else {
                for (index, child) in children.enumerated() {
                    try visit(child, path: "\(path).children[\(index)]", depth: depth + 1, count: &count)
                }
            }
        }
        if let child = fields["child"] {
            try visit(child, path: "\(path).child", depth: depth + 1, count: &count)
        }
    }

    private static func visitLiteralChildren(
        _ spec: [String: JSONValue], children: [JSONValue], path: String, depth: Int, count: inout Int
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
                    count: &count
                )
            }
        }
    }

    private static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }
}
