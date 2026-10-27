import Foundation

extension PrototypeContractValidator {
    mutating func array(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard case let .array(items) = value, let itemRule = rule["item"] else {
            throw Self.invalid(path, "Expected array")
        }
        guard Double(items.count) >= (rule["min"]?.numberValue ?? 0),
              Double(items.count) <= (rule["max"]?.numberValue ?? .infinity)
        else { throw Self.invalid(path, "Array length out of range") }
        var seen: [JSONValue] = []
        for (index, item) in items.enumerated() {
            let childPath = "\(path)[\(index)]"
            try walk(item, rule: itemRule, path: childPath, depth: depth)
            if rule["unique"] == .bool(true) {
                let canonical = item.objectFields?["dp"] ?? item
                let duplicate = seen.contains { previous in
                    if let left = previous.stringValue, let right = canonical.stringValue {
                        return left.utf16.elementsEqual(right.utf16)
                    }
                    return previous == canonical
                }
                if duplicate { throw Self.invalid(childPath, "Duplicate array value") }
                seen.append(canonical)
            }
        }
    }

    mutating func map(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard let fields = value.objectFields, let itemRule = rule["item"] else {
            throw Self.invalid(path, "Expected object")
        }
        let kind = rule["kind"]?.stringValue
        if kind == "screenMap", !(1 ... PrototypeLimits.maxStackScreens).contains(fields.count) {
            throw Self.invalid(path, "Screen count out of range")
        }
        if kind == "map", Double(fields.count) > (rule["maxEntries"]?.numberValue ?? .infinity) {
            throw Self.invalid(path, "Map entry limit exceeded")
        }
        if kind == "record", Double(fields.count) > (rule["maxEntries"]?.numberValue ?? .infinity) {
            throw Self.invalid(path, "Record entry limit exceeded")
        }
        for key in Self.sorted(fields.keys) {
            let childPath = kind == "screenMap" ? "\(path)[\(Self.quoted(key))]" : Self.keyPath(path, key)
            if kind == "map", !PrototypeRepeat.isFieldName(key) {
                throw Self.invalid(childPath, "Invalid state key")
            }
            if key.isEmpty, kind != "map" {
                throw Self.invalid(childPath, kind == "screenMap" ? "Empty screen name" : "Invalid context name")
            }
            if let child = fields[key] { try walk(child, rule: itemRule, path: childPath, depth: depth) }
        }
    }

    mutating func choice(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard case let .array(options)? = rule["options"] else {
            throw Self.invalid(path, "Invalid union value")
        }
        var first: PrototypeLoadError?
        for option in options where Self.candidate(value, kind: option.objectFields?["kind"]?.stringValue) {
            // Union probing must not consume node/image budgets for an unsuccessful branch.
            var trial = self
            do {
                try trial.walk(value, rule: option, path: path, depth: depth)
                self = trial
                return
            } catch let error as PrototypeLoadError { if first == nil { first = error } }
        }
        throw first ?? Self.invalid(path, "Invalid union value")
    }

    private static func candidate(_ value: JSONValue, kind: String?) -> Bool {
        switch (kind, value) {
        case ("array", .array), ("object", .object), ("number", .number): true
        case ("scalar", _): value.isScalar
        case ("array", _), ("object", _), ("number", _): false
        default: value.stringValue != nil
        }
    }

    static func quoted(_ value: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }
}
