import Foundation

/// Pure applier for `patch_prototype` ops (#11675); semantics shared with Kotlin and TypeScript.
enum PrototypePatch {
    enum StateTests { case evaluate, skip }
    struct Failure: Error, Equatable {
        let path: String
        let message: String
    }

    static func apply(
        spec: JSONValue, ops: JSONValue, stateTests: StateTests = .evaluate
    )
        -> Result<JSONValue, Failure>
    {
        do {
            return try .success(applyOperations(spec: spec, ops: ops, tests: stateTests))
        } catch {
            return .failure(error)
        }
    }

    private static func applyOperations(
        spec: JSONValue, ops: JSONValue, tests: StateTests
    )
        throws(Failure) -> JSONValue
    {
        guard case var .object(current) = spec else { throw Failure(path: "$", message: "Expected object") }
        guard case let .array(operations) = ops else { throw Failure(path: "ops", message: "Expected array") }
        guard (1 ... PrototypeLimits.maxPatchOps).contains(operations.count) else {
            throw Failure(path: "ops", message: "Array length out of range")
        }
        for (index, value) in operations.enumerated() {
            let location = "ops[\(index)]"
            let operation = try shape(value, location: location)
            current = try applyOp(current, operation: operation, location: location, tests: tests)
        }
        return .object(current)
    }

    static func touchesState(_ ops: JSONValue) -> Bool {
        guard case let .array(items) = ops else { return false }
        return items.contains { value in
            guard case let .object(operation) = value,
                  let path = get(operation, "path")?.stringValue else { return false }
            return path.utf16.elementsEqual("/state".utf16) || path.utf16.starts(with: "/state/".utf16)
        }
    }

    // Swift dictionary lookup treats canonically equivalent strings as the same key.
    // All patch lookups and comparisons use exact UTF-16, like PrototypeDataPointer.resolve.
    private static func get(_ fields: [String: JSONValue], _ key: String) -> JSONValue? {
        guard let index = fields.index(forKey: key),
              fields[index].key.utf16.elementsEqual(key.utf16) else { return nil }
        return fields[index].value
    }

    private static func put(_ fields: inout [String: JSONValue], _ key: String, _ value: JSONValue?) {
        // Removing first also replaces the stored spelling when add overwrites an equivalent key.
        fields.removeValue(forKey: key)
        fields[key] = value
    }

    private static func shape(_ value: JSONValue, location: String) throws(Failure) -> [String: JSONValue] {
        guard case let .object(operation) = value else { throw Failure(path: location, message: "Expected object") }
        guard let name = get(operation, "op")?.stringValue,
              ["add", "replace", "remove", "test", "replaceNode"].contains(name)
        else {
            throw Failure(path: "\(location).op", message: "Unknown or missing op")
        }
        let required = name == "replaceNode" ? ["id", "node"] : name == "remove" ? ["path"] : ["path", "value"]
        let unknown = operation.keys.filter { $0 != "op" && !required.contains($0) }.sorted {
            $0.unicodeScalars.map(\.value).lexicographicallyPrecedes($1.unicodeScalars.map(\.value))
        }
        if let key = unknown.first { throw Failure(path: "\(location).\(key)", message: "Unknown property") }
        for key in required where get(operation, key) == nil {
            throw Failure(path: "\(location).\(key)", message: "Required property")
        }
        try checkTypes(operation, name: name, location: location)
        return operation
    }

    private static func checkTypes(_ operation: [String: JSONValue], name: String, location: String) throws(Failure) {
        if name == "replaceNode" {
            guard let id = get(operation, "id")?.stringValue, !id.isEmpty else {
                throw Failure(path: "\(location).id", message: "Expected string")
            }
            guard case .object? = get(operation, "node") else {
                throw Failure(path: "\(location).node", message: "Expected object")
            }
        } else if get(operation, "path")?.stringValue == nil {
            throw Failure(path: "\(location).path", message: "Expected string")
        }
    }

    private static func pathTokens(_ path: String, location: String) throws(Failure) -> (String, [String]) {
        let units = Array(path.utf16)
        let prefix = units.split(separator: 47, omittingEmptySubsequences: false).dropFirst().first.map {
            String(decoding: $0, as: UTF16.self)
        }
        if units.first == 47, let prefix, ["root", "window", "theme"].contains(prefix) {
            throw Failure(
                path: "\(location).path",
                message:
                "Not patchable: use show for window, theme and root changes, or replaceNode for one node"
            )
        }
        let suffix = String(
            decoding: units.dropFirst(prefix == "data" ? "/data".utf16.count : "/state".utf16.count),
            as: UTF16.self
        )
        guard units.first == 47, let prefix, ["data", "state"].contains(prefix),
              suffix.isEmpty || PrototypeDataPointer.isValid(suffix)
        else {
            throw Failure(path: "\(location).path", message: "Patch paths start with /data or /state")
        }
        return (prefix, PrototypeDataPointer.tokens(suffix))
    }

    private static func applyOp(
        _ spec: [String: JSONValue], operation: [String: JSONValue], location: String, tests: StateTests
    )
        throws(Failure) -> [String: JSONValue]
    {
        if get(operation, "op")?
            .stringValue == "replaceNode" { return try replaceNode(spec, operation: operation, location: location) }
        let (prefix, tokens) = try pathTokens(get(operation, "path")?.stringValue ?? "", location: location)
        if prefix ==
            "state"
        {
            return try applyState(spec, operation: operation, tokens: tokens, location: location, tests: tests)
        }
        let result = try change(.object(spec), tokens: ["data"] + tokens, operation: operation, location: location)
        if case let .object(fields) = result { return fields }
        return spec
    }

    private static func applyState(
        _ spec: [String: JSONValue], operation: [String: JSONValue], tokens: [String], location: String,
        tests: StateTests
    )
        throws(Failure) -> [String: JSONValue]
    {
        guard tokens.count == 1, let key = tokens.first else {
            throw Failure(path: "\(location).path", message: "State patches address one key: /state/<key>")
        }
        guard PrototypeRepeat.isFieldName(key) else {
            throw Failure(path: "\(location).path", message: "Invalid state key")
        }
        let name = get(operation, "op")?.stringValue
        if name != "remove", !(get(operation, "value").map(PrototypeDataValues.isScalar) ?? false) {
            throw Failure(path: "\(location).value", message: "Invalid scalar value")
        }
        var state: [String: JSONValue] = [:]
        if case let .object(fields)? = get(spec, "state") { state = fields }
        if name != "add", get(state, key) == nil { throw missing(location) }
        if name == "test", tests == .skip { return spec }
        state = try member(state, key: key, operation: operation, location: location)
        if name == "test" { return spec }
        var result = spec
        put(&result, "state", .object(state))
        return result
    }

    private static func missing(_ location: String) -> Failure {
        Failure(path: "\(location).path", message: "Path does not exist")
    }

    private static func arrayIndex(_ token: String, count: Int, add: Bool) -> Int? {
        if add, token == "-" { return count }
        let digits = Array(token.utf16)
        guard token == "0" || (
            digits.first.map { (49 ... 57).contains($0) } == true &&
                digits.allSatisfy { (48 ... 57).contains($0) }
        ), let index = Int(token), index < count || (add && index == count) else { return nil }
        return index
    }

    private static func change(
        _ parent: JSONValue, tokens: [String], operation: [String: JSONValue], location: String
    )
        throws(Failure) -> JSONValue
    {
        guard let key = tokens.first else { throw missing(location) }
        if tokens.count == 1 {
            switch parent {
            case let .object(fields): return try .object(member(
                    fields,
                    key: key,
                    operation: operation,
                    location: location
                ))
            case let .array(items): return try .array(array(items, key: key, operation: operation, location: location))
            default: throw missing(location)
            }
        }
        return try changeChild(
            parent,
            key: key,
            rest: Array(tokens.dropFirst()),
            operation: operation,
            location: location
        )
    }

    private static func changeChild(
        _ parent: JSONValue, key: String, rest: [String], operation: [String: JSONValue], location: String
    )
        throws(Failure) -> JSONValue
    {
        switch parent {
        case var .object(fields):
            guard let child = get(fields, key) else { throw missing(location) }
            try put(&fields, key, change(child, tokens: rest, operation: operation, location: location))
            return .object(fields)
        case var .array(items):
            guard let index = arrayIndex(key, count: items.count, add: false) else { throw missing(location) }
            items[index] = try change(items[index], tokens: rest, operation: operation, location: location)
            return .array(items)
        default: throw missing(location)
        }
    }

    private static func member(
        _ parent: [String: JSONValue], key: String, operation: [String: JSONValue], location: String
    )
        throws(Failure) -> [String: JSONValue]
    {
        let name = get(operation, "op")?.stringValue
        if name != "add", get(parent, key) == nil { throw missing(location) }
        if name == "test" {
            guard equal(get(parent, key), get(operation, "value")) else {
                throw Failure(path: "\(location).value", message: "Test failed")
            }
            return parent
        }
        var fields = parent
        put(&fields, key, name == "remove" ? nil : get(operation, "value"))
        return fields
    }

    private static func array(
        _ parent: [JSONValue], key: String, operation: [String: JSONValue], location: String
    )
        throws(Failure) -> [JSONValue]
    {
        let name = get(operation, "op")?.stringValue
        guard let index = arrayIndex(key, count: parent.count, add: name == "add") else { throw missing(location) }
        var items = parent
        switch name {
        case "test":
            guard equal(items[index], get(operation, "value")) else {
                throw Failure(path: "\(location).value", message: "Test failed")
            }
        case "remove": items.remove(at: index)
        case "add": if let value = get(operation, "value") { items.insert(value, at: index) }
        case "replace": if let value = get(operation, "value") { items[index] = value }
        default: break
        }
        return items
    }

    private static func equal(_ left: JSONValue?, _ right: JSONValue?) -> Bool {
        switch (left, right) {
        case (.null?, .null?): return true
        case let (.string(first)?, .string(second)?): return first.utf16.elementsEqual(second.utf16)
        case let (.bool(first)?, .bool(second)?): return first == second
        case let (.number(first)?, .number(second)?): return first == second
        case let (.array(first)?, .array(second)?):
            guard first.count == second.count else { return false }
            return zip(first, second).allSatisfy { equal($0.0, $0.1) }
        case let (.object(first)?, .object(second)?):
            return first.count == second.count && first.allSatisfy { key, value in equal(value, get(second, key)) }
        default: return false
        }
    }

    private struct Entry {
        let node: [String: JSONValue]
        let tokens: [String]
        let path: String
        let insideRepeat: Bool
    }

    private static func tree(
        _ node: [String: JSONValue], tokens: [String], path: String, insideRepeat: Bool = false
    )
        -> [Entry]
    {
        var result = [Entry(node: node, tokens: tokens, path: path, insideRepeat: insideRepeat)]
        let repeated = insideRepeat || get(node, "repeat") != nil
        if case let .object(child)? = get(node, "child") {
            result += tree(child, tokens: tokens + ["child"], path: "\(path).child", insideRepeat: repeated)
        }
        if case let .array(children)? = get(node, "children") {
            for (index, value) in children.enumerated() {
                if case let .object(child) = value {
                    result += tree(
                        child,
                        tokens: tokens + ["children", String(index)],
                        path: "\(path).children[\(index)]",
                        insideRepeat: repeated
                    )
                }
            }
        }
        if case let .object(screens)? = get(node, "screens") {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if case let .object(child)? = screens[name] {
                    result += tree(
                        child,
                        tokens: tokens + ["screens", name],
                        path: PrototypeStacks.screenPath(path, name: name),
                        insideRepeat: repeated
                    )
                }
            }
        }
        return result
    }

    private static func replacement(_ operation: [String: JSONValue], location: String) throws(Failure) -> JSONValue {
        guard case let .object(node)? = get(operation, "node") else {
            throw Failure(path: "\(location).node", message: "Expected object")
        }
        guard let id = get(node, "id")?.stringValue,
              let target = get(operation, "id")?.stringValue, id.utf16.elementsEqual(target.utf16)
        else {
            throw Failure(path: "\(location).node.id", message: "Replacement must keep the same id")
        }
        try checkSubtree(node, path: "\(location).node")
        return .object(node)
    }

    private static func checkSubtree(_ node: [String: JSONValue], path: String) throws(Failure) {
        try checkReplacement(Entry(node: node, tokens: [], path: path, insideRepeat: false))
        if case let .object(child)? = get(node, "child") {
            try checkSubtree(child, path: "\(path).child")
        }
        if case let .array(children)? = get(node, "children") {
            for (index, value) in children.enumerated() {
                if case let .object(child) = value {
                    try checkSubtree(child, path: "\(path).children[\(index)]")
                }
            }
        }
        if case let .object(screens)? = get(node, "screens") {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if case let .object(child)? = screens[name] {
                    try checkSubtree(child, path: PrototypeStacks.screenPath(path, name: name))
                }
            }
        }
    }

    private static func checkReplacement(_ entry: Entry) throws(Failure) {
        if get(entry.node, "type")?.stringValue == "use" {
            throw Failure(
                path: "\(entry.path).type",
                message:
                "Components are not expanded in a patch: inline the node or use show"
            )
        }
        if case let .object(anchor)? = get(entry.node, "anchor"), get(anchor, "type")?.stringValue == "element" {
            throw Failure(
                path: "\(entry.path).anchor.type",
                message:
                "Element anchors are resolved by show: use a bounds anchor or use show"
            )
        }
    }

    private static func replaceNode(
        _ spec: [String: JSONValue], operation: [String: JSONValue], location: String
    )
        throws(Failure) -> [String: JSONValue]
    {
        let node = try replacement(operation, location: location)
        var entries: [Entry] = []
        if case let .object(root)? = get(spec, "root") { entries = tree(root, tokens: ["root"], path: "root") }
        let matches = entries.filter { equal(get($0.node, "id"), get(operation, "id")) }
        guard let match = matches.first else { throw Failure(path: "\(location).id", message: "Unknown node id") }
        guard matches.count == 1 else { throw Failure(path: "\(location).id", message: "Node id is not unique") }
        guard match.tokens.count > 1 else {
            throw Failure(path: "\(location).id", message: "The root cannot be replaced: use show")
        }
        guard !match.insideRepeat else {
            throw Failure(
                path: "\(location).id",
                message:
                "A node inside a repeat cannot be replaced: replace the repeating node"
            )
        }
        let result = try change(
            .object(spec),
            tokens: match.tokens,
            operation: ["op": .string("replace"), "value": node],
            location: location
        )
        if case let .object(fields) = result { return fields }
        return spec
    }
}
