import Foundation

/// Total RFC 6901 lookup relative to the read-only data object, using Kotlin's UTF-16 grammar.
enum PrototypeDataPointer {
    static func isValid(_ pointer: String) -> Bool {
        let units = Array(pointer.utf16)
        guard (1 ... PrototypeLimits.maxDataPointerLength).contains(units.count), units.first == 47 else {
            return false
        }
        var cursor = 0
        while cursor < units.count {
            if units[cursor] == 126 {
                guard cursor + 1 < units.count, units[cursor + 1] == 48 || units[cursor + 1] == 49 else {
                    return false
                }
                cursor += 1
            }
            cursor += 1
        }
        return true
    }

    static func tokens(_ pointer: String) -> [String] {
        guard isValid(pointer) else { return [] }
        return pointer.utf16.dropFirst().split(separator: 47, omittingEmptySubsequences: false).map {
            String(decoding: $0, as: UTF16.self)
                .replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        }
    }

    static func resolve(_ data: [String: JSONValue]?, pointer: String) -> JSONValue? {
        guard isValid(pointer), let data else { return nil }
        var value: JSONValue = .object(data)
        for token in tokens(pointer) {
            switch value {
            case let .object(fields):
                // Swift strings compare canonically; pointer members require exact UTF-16 keys.
                guard let index = fields.index(forKey: token),
                      fields[index].key.utf16.elementsEqual(token.utf16) else { return nil }
                value = fields[index].value
            case let .array(items):
                let digits = Array(token.utf16)
                guard token == "0" || (
                    digits.first.map { (49 ... 57).contains($0) } == true &&
                        digits.allSatisfy { (48 ... 57).contains($0) }
                ), let index = Int(token), items.indices.contains(index) else { return nil }
                value = items[index]
            default: return nil
            }
        }
        return value
    }
}

/// Shared scalar projection and comparison semantics, matching `PrototypeDataValues` on Kotlin.
enum PrototypeDataValues {
    static func isScalar(_ value: JSONValue) -> Bool {
        if case let .number(number) = value { return number.isFinite }
        return value.isScalar
    }

    static func project(_ item: [String: JSONValue]) -> JSONValue {
        .object(item.filter { PrototypeRepeat.isFieldName($0.key) && isScalar($0.value) })
    }

    static func holds(_ condition: [String: JSONValue], data: [String: JSONValue]?) -> Bool {
        guard case let .string(pointer)? = condition["data"] else { return false }
        let value = PrototypeDataPointer.resolve(data, pointer: pointer)
        func equal(_ operand: JSONValue) -> Bool {
            guard let value, isScalar(value), isScalar(operand) else { return false }
            if case let .string(left) = value, case let .string(right) = operand {
                return left.utf16.elementsEqual(right.utf16)
            }
            return value == operand
        }
        if let operand = condition["equals"] { return equal(operand) }
        if let operand = condition["notEquals"] { return !equal(operand) }
        guard case let .number(left)? = value, left.isFinite else { return false }
        if case let .number(right)? = condition["gt"], right.isFinite { return left > right }
        if case let .number(right)? = condition["lt"], right.isFinite { return left < right }
        return false
    }
}

/// Scans authored UTF-16 once, just like Kotlin; replacement values are never scanned again.
enum PrototypeDataText {
    static func bind(_ text: String, data: [String: JSONValue]?) -> String {
        let units = Array(text.utf16)
        var result = ""
        var cursor = 0
        var literalStart = 0
        while cursor < units.count {
            if units[cursor] == 123,
               let close = units[(cursor + 1)...].firstIndex(of: 125)
            {
                let inner = units[(cursor + 1) ..< close]
                let pointer = inner.starts(with: [100, 97, 116, 97, 58])
                    ? String(decoding: inner.dropFirst(5), as: UTF16.self) : ""
                if PrototypeDataPointer.isValid(pointer) {
                    result += String(decoding: units[literalStart ..< cursor], as: UTF16.self)
                    let value = PrototypeDataPointer.resolve(data, pointer: pointer)
                    result += value.map { PrototypeDataValues.isScalar($0) ? $0.displayString : "" } ?? ""
                    cursor = close + 1
                    literalStart = cursor
                    continue
                }
            }
            cursor += 1
        }
        result += String(decoding: units[literalStart...], as: UTF16.self)
        return result
    }
}

/// Pure, one-time resolution before structural limits, repeat expansion and state interpolation.
enum PrototypeDataResolver {
    static func resolveRoot(_ root: JSONValue, data: [String: JSONValue]?) -> JSONValue {
        guard case var .object(fields) = root else { return root }
        PrototypeRepeat.bindTextFields(&fields) { PrototypeDataText.bind($0, data: data) }
        if let value = fields["repeat"] { fields["repeat"] = resolveRepeat(value, data: data) }
        if let value = fields["visibleWhen"] { fields["visibleWhen"] = resolveCondition(value, data: data) }
        if case let .array(styles)? = fields["styleWhen"] {
            fields["styleWhen"] = .array(styles.map { entry in
                guard case var .object(style) = entry, let condition = style["when"] else { return entry }
                style["when"] = resolveCondition(condition, data: data)
                return .object(style)
            })
        }
        if let child = fields["child"] {
            fields["child"] = resolveRoot(child, data: data)
        } else if case let .array(children)? = fields["children"] {
            fields["children"] = .array(children.map { resolveRoot($0, data: data) })
        }
        return .object(fields)
    }

    private static func resolveRepeat(_ value: JSONValue, data: [String: JSONValue]?) -> JSONValue {
        guard case var .object(fields) = value, case let .object(source)? = fields["items"] else {
            return value
        }
        let pointer = source["path"]?.stringValue ?? ""
        let resolved = PrototypeDataPointer.resolve(data, pointer: pointer)
        let array: [JSONValue] = if case let .array(items)? = resolved { items } else { [] }
        // Kotlin skips non-objects before taking the first maxRepeatItems projected rows.
        let objects = array.compactMap { item -> [String: JSONValue]? in
            if case let .object(fields) = item { return fields }
            return nil
        }
        fields["items"] = .array(objects.prefix(PrototypeLimits.maxRepeatItems).map(PrototypeDataValues.project))
        return .object(fields)
    }

    private static func resolveCondition(_ value: JSONValue, data: [String: JSONValue]?) -> JSONValue {
        guard case var .object(fields) = value else { return value }
        if fields["data"] != nil {
            let form = PrototypeDataValues.holds(fields, data: data) ? "all" : "any"
            return .object([form: .array([])])
        }
        if let negated = fields["not"] { fields["not"] = resolveCondition(negated, data: data) }
        for group in ["all", "any"] {
            if case let .array(conditions)? = fields[group] {
                fields[group] = .array(conditions.map { resolveCondition($0, data: data) })
            }
        }
        return .object(fields)
    }
}
