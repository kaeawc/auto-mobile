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
        return resolve(.object(data), tokens: tokens(pointer)[...])
    }

    /// Walks already-decoded pointer tokens from `root`; nil when any step is missing.
    static func resolve(_ root: JSONValue, tokens: ArraySlice<String>) -> JSONValue? {
        var value = root
        for token in tokens {
            switch value {
            case let .object(fields):
                guard let member = exactKey(token, in: fields) else { return nil }
                value = fields[member].value
            case let .array(items):
                guard let index = arrayIndex(token), items.indices.contains(index) else { return nil }
                value = items[index]
            default: return nil
            }
        }
        return value
    }

    /// Swift strings compare canonically; pointer members require exact UTF-16 keys.
    static func exactKey(_ token: String, in fields: [String: JSONValue]) -> Dictionary<String, JSONValue>.Index? {
        guard let index = fields.index(forKey: token),
              fields[index].key.utf16.elementsEqual(token.utf16) else { return nil }
        return index
    }

    /// An RFC 6901 array index: `0` or digits without a leading zero.
    static func arrayIndex(_ token: String) -> Int? {
        let digits = Array(token.utf16)
        guard token == "0" || (
            digits.first.map { (49 ... 57).contains($0) } == true &&
                digits.allSatisfy { (48 ... 57).contains($0) }
        ) else { return nil }
        return Int(token)
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

    /// A missing value, `null`, `[]`, `{}` or `""` is empty (#14207); every other value is not.
    static func isEmpty(_ value: JSONValue?) -> Bool {
        switch value {
        case nil, .null?: true
        case let .array(items)?: items.isEmpty
        case let .object(members)?: members.isEmpty
        case let .string(text)?: text.isEmpty
        case .bool?, .number?: false
        }
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
        if case let .bool(empty)? = condition["empty"] { return isEmpty(value) == empty }
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
    static func bind(_ text: String, data: [String: JSONValue]?, platform: [String: JSONValue]? = nil) -> String {
        let units = Array(text.utf16)
        var result = ""
        var literalStart = 0
        scan(units, includePlatform: true) { open, close, pointer, isPlatform in
            result += String(decoding: units[literalStart ..< open], as: UTF16.self)
            result += rendered(pointer, data: isPlatform ? platform : data)
            literalStart = close + 1
            return true
        }
        result += String(decoding: units[literalStart...], as: UTF16.self)
        return result
    }

    static func exceedsSubstitutionLimit(_ text: String, data: [String: JSONValue]?) -> Bool {
        substitutionLength(text, data: data).length > PrototypeLimits.maxSubstitutedTextLength
    }

    /// Recognition is independent of rendered length: empty replacements still rebuild text.
    static func substitutionLength(
        _ text: String, data: [String: JSONValue]?
    )
        -> (recognized: Bool, length: Int)
    {
        var recognized = false
        var length = 0
        scan(Array(text.utf16)) { _, _, pointer, _ in
            recognized = true
            length += rendered(pointer, data: data).utf16.count
            return length <= PrototypeLimits.maxSubstitutedTextLength
        }
        return (recognized, length)
    }

    private static func rendered(_ pointer: String, data: [String: JSONValue]?) -> String {
        guard let value = PrototypeDataPointer.resolve(data, pointer: pointer),
              PrototypeDataValues.isScalar(value) else { return "" }
        return value.displayString
    }

    /// Returning false stops the shared scanner before any oversized binding is constructed.
    private static func scan(
        _ units: [UInt16],
        includePlatform: Bool = false,
        visit: (Int, Int, String, Bool) -> Bool
    ) {
        var cursor = 0
        while cursor < units.count {
            let isPlatform = includePlatform && units.dropFirst(cursor + 1).starts(with: Array("platform:".utf16))
            let prefix = Array((isPlatform ? "platform:" : "data:").utf16)
            let end = min(units.count, cursor + 2 + prefix.count + PrototypeLimits.maxDataPointerLength)
            if units[cursor] == 123,
               units[(cursor + 1) ..< end].starts(with: prefix),
               let close = units[(cursor + 1) ..< end].firstIndex(of: 125)
            {
                let pointer = String(decoding: units[(cursor + 1 + prefix.count) ..< close], as: UTF16.self)
                if PrototypeDataPointer.isValid(pointer) {
                    guard visit(cursor, close, pointer, isPlatform) else { return }
                    cursor = close + 1
                    continue
                }
            }
            cursor += 1
        }
    }
}

/// Pure, one-time resolution after authored limits, before repeat expansion and state interpolation.
enum PrototypeDataResolver {
    static func resolveRoot(
        _ root: JSONValue,
        data: [String: JSONValue]?,
        platform: [String: JSONValue]? = nil
    )
        -> JSONValue
    {
        var repeats = PrototypeRepeatData(data: data)
        return resolveRoot(root, data: data, platform: platform, repeats: &repeats)
    }

    private static func resolveRoot(
        _ root: JSONValue, data: [String: JSONValue]?, platform: [String: JSONValue]?,
        repeats: inout PrototypeRepeatData
    )
        -> JSONValue
    {
        guard case var .object(fields) = root else { return root }
        PrototypeRepeat.bindTextFields(&fields) { PrototypeDataText.bind($0, data: data, platform: platform) }
        let lazy = fields["type"] == .string("list")
        if !lazy, let value = fields["repeat"] { fields["repeat"] = resolveRepeat(value, repeats: &repeats) }
        for key in ["visibleWhen", "enabledWhen"] {
            if let value = fields[key] { fields[key] = resolveCondition(value, data: data, platform: platform) }
        }
        if case let .array(styles)? = fields["styleWhen"] {
            fields["styleWhen"] = .array(styles.map { entry in
                guard case var .object(style) = entry, let condition = style["when"] else { return entry }
                style["when"] = resolveCondition(condition, data: data, platform: platform)
                return .object(style)
            })
        }
        if let child = fields["child"] {
            fields["child"] = resolveRoot(child, data: data, platform: platform, repeats: &repeats)
        } else if case let .array(children)? = fields["children"] {
            fields["children"] = .array(children
                .map { resolveRoot($0, data: data, platform: platform, repeats: &repeats) })
        }
        for name in ["header", "footer"] {
            if let child = fields[name] { fields[name] = resolveRoot(child, data: data, repeats: &repeats) }
        }
        if case let .object(screens)? = fields["screens"] {
            fields["screens"] = .object(screens
                .mapValues { resolveRoot($0, data: data, platform: platform, repeats: &repeats) })
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

    private static func resolveCondition(
        _ value: JSONValue,
        data: [String: JSONValue]?,
        platform: [String: JSONValue]?
    )
        -> JSONValue
    {
        guard case var .object(fields) = value else { return value }
        if fields["data"] != nil || fields["platform"] != nil {
            let isPlatform = fields["platform"] != nil
            if isPlatform { fields["data"] = fields.removeValue(forKey: "platform") }
            let form = PrototypeDataValues.holds(fields, data: isPlatform ? platform : data) ? "all" : "any"
            return .object([form: .array([])])
        }
        if let negated = fields["not"] { fields["not"] = resolveCondition(negated, data: data, platform: platform) }
        for group in ["all", "any"] {
            if case let .array(conditions)? = fields[group] {
                fields[group] = .array(conditions.map { resolveCondition($0, data: data, platform: platform) })
            }
        }
        return .object(fields)
    }
}
