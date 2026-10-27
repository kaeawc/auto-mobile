import Foundation

/// Authored validation and pure string resolution, shared by embedded and injected presentations.
enum PrototypeStrings {
    private static let categories: Set<String> = ["zero", "one", "two", "few", "many", "other"]
    private static func fail(_ path: String, _ message: String) -> PrototypeLoadError {
        PrototypeContractValidator.invalid(path, message)
    }

    static func validateTables(_ value: JSONValue) throws {
        guard let tables = value.objectFields else { throw fail("strings", "Expected string tables") }
        guard tables["default"] != nil else { throw fail("strings", "Missing default string table") }
        guard tables.count <= PrototypeContractValidator.limit("MAX_PROTOTYPE_STRING_LOCALES") else {
            throw fail("strings", "String locale limit exceeded")
        }
        var seen = Set<String>()
        // Foundation JSON loses member order, so the later of two colliding tags is the greater one.
        for tag in tables.keys.sorted() {
            let path = "strings.\(tag)"
            guard tag == "default" || PrototypeContractValidator.matches("localeTag", tag) else {
                throw fail(path, "Invalid locale tag")
            }
            guard seen.insert(normalize(tag)).inserted else { throw fail(path, "Duplicate locale tag") }
            guard let entries = tables[tag]?.objectFields else { throw fail(path, "Expected string table") }
            guard entries.count <= PrototypeContractValidator.limit("MAX_PROTOTYPE_STRING_KEYS") else {
                throw fail(path, "String key limit exceeded")
            }
            for key in PrototypeContractValidator.sorted(entries.keys) {
                let at = "\(path).\(key)"
                guard PrototypeContractValidator.matches("stringKey", key) else { throw fail(at, "Invalid string key") }
                guard let entry = entries[key] else { continue }
                let plural = entry.objectFields
                if entry.stringValue == nil, plural == nil || plural?["other"] == nil ||
                    plural?.keys.contains(where: { !categories.contains($0) }) == true
                { throw fail(at, "Invalid plural object") }
                for value in plural.map({ Array($0.values) }) ?? [entry] {
                    guard let text = value.stringValue, !text.isEmpty,
                          text.utf16.count <= PrototypeContractValidator.limit("MAX_PROTOTYPE_STRING_LENGTH")
                    else { throw fail(at, "Invalid translation string") }
                    let source = text as NSString
                    if ["{t:", "{data:", "{platform:"].contains(where: {
                        source.range(of: $0, options: .literal).location != NSNotFound
                    }) || (plural == nil && source.range(of: "{#}", options: .literal).location != NSNotFound)
                    { throw fail(at, "Forbidden translation placeholder") }
                }
            }
        }
    }

    struct Field {
        let path: String
        let text: String
        let description: Bool
    }

    static func textFields(_ value: JSONValue, path: String = "root", parent: String = "") -> [Field] {
        if case let .array(items) = value {
            return items.enumerated().flatMap { textFields($0.element, path: "\(path)[\($0.offset)]", parent: parent) }
        }
        guard let fields = value.objectFields else { return [] }
        let ordered = PrototypeContractValidator.sorted(fields.keys).sorted { left, right in
            // Foundation dictionaries have no authored order; use the contract's display-field
            // order for stable diagnostics, with nested display objects at their first field.
            func rank(_ key: String) -> Int {
                PrototypeContractValidator.stringFieldOrder.firstIndex {
                    $0.utf16.elementsEqual(key.utf16) || $0.utf16.starts(with: (key + ".").utf16)
                } ?? PrototypeContractValidator.stringFieldOrder.count
            }
            return rank(left) < rank(right)
        }
        return ordered.flatMap { key -> [Field] in
            guard !PrototypeContractValidator.stringOpaqueFields.contains(key),
                  !["child", "children", "screens"].contains(key), let child = fields[key] else { return [] }
            let at = "\(path).\(key)"
            if let text = child.stringValue,
               PrototypeContractValidator.stringFields.contains(key) ||
               PrototypeContractValidator.stringFields.contains("\(parent).\(key)") || key == "contentDescription"
            { return [Field(path: at, text: text, description: key == "contentDescription")] }
            return textFields(child, path: at, parent: key)
        }
    }

    private struct Use {
        let range: NSRange
        let key: String
        let count: String?
    }

    private static func uses(_ text: String, strict: Bool) -> [Use]? {
        // Foundation ranges and captures use UTF-16, including boundaries inside a Character.
        let source = text as NSString
        let pattern = #"\{t:([A-Za-z_][A-Za-z0-9_.-]{0,63})(?:\|(\{data:[^{}]+\}|[^{}]*))?\}"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return nil }
        var cursor = 0
        var result: [Use] = []
        while cursor < source.length {
            let remaining = NSRange(location: cursor, length: source.length - cursor)
            let start = source.range(of: "{t:", options: .literal, range: remaining)
            if start.location == NSNotFound { break }
            guard let match = expression.firstMatch(
                in: text,
                options: .anchored,
                range: NSRange(location: start.location, length: source.length - start.location)
            ) else { return nil }
            let countRange = match.range(at: 2)
            let count = countRange.location == NSNotFound ? nil : source.substring(with: countRange)
            if let count {
                if count.utf16.starts(with: "{data:".utf16) {
                    guard PrototypeDataPointer.isValid(String(count.unicodeScalars.dropFirst(6).dropLast()))
                    else { return nil }
                } else if strict, digitCount(count) == nil { return nil }
            }
            result.append(Use(range: match.range, key: source.substring(with: match.range(at: 1)), count: count))
            cursor = NSMaxRange(match.range)
        }
        return result
    }

    static func validate(spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        for node in nodes {
            if let semantics = node.value["semantics"]?.objectFields {
                if semantics.isEmpty { throw fail("\(node.path).semantics", "Expected at least one semantics field") }
                if semantics["label"] != nil, node.value["contentDescription"] != nil {
                    throw fail("\(node.path).semantics.label", "semantics.label conflicts with contentDescription")
                }
            }
        }
        let defaults = spec["strings"]?.objectFields?["default"]?.objectFields ?? [:]
        for field in nodes.flatMap({ textFields(.object($0.value), path: $0.path) })
            where (field.text as NSString).range(of: "{t:", options: .literal).location != NSNotFound
        {
            if field.description { throw fail(field.path, "Use semantics.label for string placeholders") }
            guard spec["strings"] != nil else { throw fail(field.path, "String placeholders require strings") }
            guard let uses = uses(field.text, strict: true)
            else { throw fail(field.path, "Invalid string placeholder") }
            for use in uses {
                guard let entry = defaults[use.key] else { throw fail(field.path, "Unknown string key \"\(use.key)\"") }
                if entry.stringValue == nil, use.count == nil {
                    throw fail(field.path, "String \"\(use.key)\" is plural: write {t:\(use.key)|count}")
                }
            }
        }
    }

    // Foundation literal matching and scalar slicing preserve JS code-unit token boundaries,
    // even when ASCII punctuation shares a Character with a following combining mark.
    static func normalize(_ tag: String) -> String {
        let source = tag.lowercased() as NSString
        return source.replacingOccurrences(
            of: "_", with: "-", options: .literal, range: NSRange(location: 0, length: source.length)
        )
    }

    static func localeChain(_ requested: [String]) -> [String] {
        var result: [String] = []
        for tag in requested {
            var parts = normalize(tag).unicodeScalars.split(separator: "-", omittingEmptySubsequences: false)
                .map(String.init)
            while !parts.isEmpty {
                let prefix = parts.joined(separator: "-")
                if prefix != "default", !result.contains(where: { $0.utf16.elementsEqual(prefix.utf16) }) {
                    result.append(prefix)
                }
                parts.removeLast()
            }
        }
        return result + ["default"]
    }

    static func pluralCategory(_ language: String, _ n: Double) -> String {
        guard n.isFinite, n >= 0, n <= 9_007_199_254_740_991, n.rounded() == n else { return "other" }
        let lang = normalize(language).unicodeScalars.split(separator: "-", omittingEmptySubsequences: false)
            .first.map(String.init) ?? "en"
        if ["ja", "zh", "ko", "vi", "th", "id", "ms", "lo", "km", "my"].contains(lang) { return "other" }
        if ["fr", "pt", "hi", "bn", "fa", "gu", "kn", "am"].contains(lang) { return n <= 1 ? "one" : "other" }
        let mod10 = Int(n.truncatingRemainder(dividingBy: 10))
        let mod100 = Int(n.truncatingRemainder(dividingBy: 100))
        if ["ru", "uk", "be", "pl"].contains(lang) {
            if lang == "pl" ? n == 1 : mod10 == 1 && mod100 != 11 { return "one" }
            return (2 ... 4).contains(mod10) && !(12 ... 14).contains(mod100) ? "few" : "many"
        }
        if ["cs", "sk"].contains(lang) { return n == 1 ? "one" : (2 ... 4).contains(n) ? "few" : "other" }
        if lang == "ar" {
            if n == 0 { return "zero" }; if n == 1 { return "one" }; if n == 2 { return "two" }
            if (3 ... 10).contains(mod100) { return "few" }
            return (11 ... 99).contains(mod100) ? "many" : "other"
        }
        return n == 1 ? "one" : "other"
    }

    private static func digitCount(_ text: String) -> Double? {
        let scalars = text.unicodeScalars
        guard (1 ... 9).contains(scalars.count), scalars.allSatisfy({ (48 ... 57).contains($0.value) })
        else { return nil }
        return Double(text)
    }

    private static func translationCount(_ value: String?, data: [String: JSONValue]?) -> Double? {
        guard let value else { return nil }
        if value.utf16.starts(with: "{data:".utf16) {
            let raw = PrototypeDataPointer.resolve(data, pointer: String(value.unicodeScalars.dropFirst(6).dropLast()))
            if let number = raw?.numberValue {
                return number.isFinite && number >= 0 && number <= 999_999_999 && number.rounded() == number
                    ? number : nil
            }
            return raw?.stringValue.flatMap(digitCount)
        }
        return digitCount(value)
    }

    static func resolveText(
        _ text: String,
        strings: JSONValue,
        locales: [String],
        data: [String: JSONValue]? = nil
    )
        -> String
    {
        guard let uses = uses(text, strict: false) else { return text }
        var tables: [String: JSONValue] = [:]
        for (tag, table) in strings.objectFields ?? [:] {
            tables[normalize(tag)] = table
        }
        let source = text as NSString
        var result = "", cursor = 0
        for use in uses {
            let tag = localeChain(locales).first { tables[$0]?.objectFields?[use.key] != nil }
            let entry = tag.flatMap { tables[$0]?.objectFields?[use.key] }
            let count = translationCount(use.count, data: data)
            let language = tag == "default" ? locales.first ?? "en" : tag ?? "en"
            let category = count.map { pluralCategory(language, $0) } ?? "other"
            var translated = entry?.stringValue ?? entry?.objectFields?[category]?.stringValue ?? entry?
                .objectFields?["other"]?.stringValue ?? use.key
            if let count {
                let translation = translated as NSString
                translated = translation.replacingOccurrences(
                    of: "{#}",
                    with: PrototypeScalarText.render(count),
                    options: .literal,
                    range: NSRange(location: 0, length: translation.length)
                )
            }
            result += source.substring(with: NSRange(location: cursor, length: use.range.location - cursor)) +
                translated
            cursor = NSMaxRange(use.range)
        }
        return result + source.substring(from: cursor)
    }

    static func resolve(
        _ value: JSONValue,
        strings: JSONValue,
        locales: [String],
        data: [String: JSONValue]?,
        parent: String = ""
    )
        -> JSONValue
    {
        if case let .array(items) = value { return .array(items.map { resolve(
            $0,
            strings: strings,
            locales: locales,
            data: data,
            parent: parent
        ) }) }
        guard let fields = value.objectFields else { return value }
        return .object(fields.reduce(into: [String: JSONValue]()) { result, pair in
            let (key, child) = pair
            if PrototypeContractValidator.stringOpaqueFields.contains(key) { result[key] = child }
            else if let text = child.stringValue,
                    PrototypeContractValidator.stringFields.contains(key) || PrototypeContractValidator.stringFields
                    .contains("\(parent).\(key)")
            {
                result[key] = .string(resolveText(text, strings: strings, locales: locales, data: data))
            } else { result[key] = resolve(child, strings: strings, locales: locales, data: data, parent: key) }
        })
    }
}

protocol PrototypeLocaleProvider: Sendable { var preferredLanguages: [String] { get } }
struct SystemPrototypeLocaleProvider: PrototypeLocaleProvider {
    var preferredLanguages: [String] { Locale.preferredLanguages }
}

struct PrototypeSemantics: Decodable {
    let heading: Bool?
    let liveRegion: String?
    let group: Bool?
    let label: String?
    let hint: String?
    let traits: [String]?
}

struct PrototypeAnnouncement: Equatable {
    let text: String
    let assertive: Bool
    static func change(previous: String?, current: String, liveRegion: String?) -> Self? {
        guard previous != nil, previous != current, !current.isEmpty, let liveRegion else { return nil }
        return Self(text: current, assertive: liveRegion == "assertive")
    }
}
