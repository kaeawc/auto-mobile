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
        return pointer.utf16.dropFirst().split(separator: 47, omittingEmptySubsequences: false).map { token in
            let units = Array(token)
            var decoded: [UInt16] = []
            var cursor = 0
            while cursor < units.count {
                if units[cursor] == 126, cursor + 1 < units.count {
                    decoded.append(units[cursor + 1] == 49 ? 47 : 126)
                    cursor += 2
                } else {
                    decoded.append(units[cursor])
                    cursor += 1
                }
            }
            return String(decoding: decoded, as: UTF16.self)
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
        let value = condition["data"]?.stringValue.flatMap {
            PrototypeDataPointer.resolve(data, pointer: $0)
        }
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

/// One guard or resolver call's cache. UTF-16 keys keep canonically equivalent pointers distinct.
/// JSONValue and its collections have value semantics; sharing their storage cannot mutate a caller.
struct PrototypeRepeatData {
    let data: [String: JSONValue]?
    private var sources: [[UInt16]: [[String: JSONValue]]] = [:]
    private var counts: [[UInt16]: Int] = [:]
    private var projections: [[UInt16]: JSONValue] = [:]

    init(data: [String: JSONValue]?) {
        self.data = data
    }

    private mutating func objects(_ pointer: String) -> [[String: JSONValue]] {
        let key = Array(pointer.utf16)
        if let cached = sources[key] { return cached }
        let resolved = PrototypeDataPointer.resolve(data, pointer: pointer)
        let array: [JSONValue] = if case let .array(items)? = resolved { items } else { [] }
        let objects = Array(array.compactMap { item -> [String: JSONValue]? in
            if case let .object(fields) = item { return fields }
            return nil
        }.prefix(PrototypeLimits.maxRepeatItems))
        sources[key] = objects
        return objects
    }

    mutating func cells(_ pointer: String) -> Int {
        let key = Array(pointer.utf16)
        if let cached = counts[key] { return cached }
        let count = objects(pointer).reduce(0) { total, item in
            total + max(1, item.reduce(0) { count, member in
                count + (
                    PrototypeRepeat.isFieldName(member.key) &&
                        PrototypeDataValues.isScalar(member.value) ? 1 : 0
                )
            })
        }
        counts[key] = count
        return count
    }

    mutating func items(_ pointer: String) -> JSONValue {
        let key = Array(pointer.utf16)
        if let cached = projections[key] { return cached }
        let projected = JSONValue.array(objects(pointer).map(PrototypeDataValues.project))
        projections[key] = projected
        return projected
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
            let end = min(units.count, cursor + 2 + 5 + PrototypeLimits.maxDataPointerLength)
            if units[cursor] == 123,
               units[(cursor + 1) ..< end].starts(with: [100, 97, 116, 97, 58]),
               let close = units[(cursor + 1) ..< end].firstIndex(of: 125)
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

/// Pure, one-time resolution after authored limits, before repeat expansion and state interpolation.
enum PrototypeDataResolver {
    static func resolveRoot(_ root: JSONValue, data: [String: JSONValue]?) -> JSONValue {
        var repeats = PrototypeRepeatData(data: data)
        return resolveRoot(root, data: data, repeats: &repeats)
    }

    private static func resolveRoot(
        _ root: JSONValue, data: [String: JSONValue]?, repeats: inout PrototypeRepeatData
    )
        -> JSONValue
    {
        guard case var .object(fields) = root else { return root }
        PrototypeRepeat.bindTextFields(&fields) { PrototypeDataText.bind($0, data: data) }
        if let value = fields["repeat"] { fields["repeat"] = resolveRepeat(value, repeats: &repeats) }
        if let value = fields["visibleWhen"] { fields["visibleWhen"] = resolveCondition(value, data: data) }
        if case let .array(styles)? = fields["styleWhen"] {
            fields["styleWhen"] = .array(styles.map { entry in
                guard case var .object(style) = entry, let condition = style["when"] else { return entry }
                style["when"] = resolveCondition(condition, data: data)
                return .object(style)
            })
        }
        if let child = fields["child"] {
            fields["child"] = resolveRoot(child, data: data, repeats: &repeats)
        } else if case let .array(children)? = fields["children"] {
            fields["children"] = .array(children.map { resolveRoot($0, data: data, repeats: &repeats) })
        }
        return .object(fields)
    }

    private static func resolveRepeat(_ value: JSONValue, repeats: inout PrototypeRepeatData) -> JSONValue {
        guard case var .object(fields) = value, case let .object(source)? = fields["items"] else {
            return value
        }
        fields["items"] = repeats.items(source["path"]?.stringValue ?? "")
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
