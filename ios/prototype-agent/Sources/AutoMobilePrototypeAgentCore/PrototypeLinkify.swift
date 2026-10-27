import Foundation

/// `linkify` on a text node (#14233): the kinds to detect, the style of a match and the actions a
/// tap runs. `onTap` stays JSON because its `{match}` bindings are bound per match before decoding.
struct PrototypeLinkifyOptions: Decodable, Sendable {
    let kinds: [String]
    let style: PrototypeTextSpanStyle?
    let onTap: JSONValue
}

/// Detection and `{match}` binding, the twin of TypeScript's `prototypeLinkify.ts`, pinned by
/// `test/fixtures/prototype-spec/linkify/cases.json`. A match starts at the start of the text or
/// after whitespace: a mention is `@` and 1 to 30 of `[A-Za-z0-9_]`, a hashtag `#` and 1 to 100 code
/// units of letters, marks, `[0-9]` or `_` (not all digits), and a URL `http://` or `https://` up
/// to whitespace, trailing `.,;:!?'")]}` removed, in the `checks` url format. Offsets are UTF-16.
enum PrototypeLinkify {
    struct Match: Equatable, Sendable {
        let kind: String
        let text: String
        let start: Int
        let end: Int
    }

    private static let maxMention = 30
    private static let maxHashtag = 100
    private static let urlFormat = try? NSRegularExpression(pattern: "^https?://[^\\s/?#]+([/?#]\\S*)?$")
    private static let trailing = Set(".,;:!?'\")]}".utf16)
    private static let spaces: Set<UInt16> = [
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
        0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ]

    private static func isWord(_ unit: UInt16) -> Bool {
        (48 ... 57).contains(unit) || (65 ... 90).contains(unit) || (97 ... 122).contains(unit) || unit == 95
    }

    private static func isHashtagScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark:
            true
        default:
            ("0" ... "9").contains(scalar) || scalar == "_"
        }
    }

    private static func mentionEnd(_ units: [UInt16], _ at: Int) -> Int? {
        var end = at + 1
        while end < units.count, isWord(units[end]) {
            end += 1
        }
        return (1 ... maxMention).contains(end - at - 1) ? end : nil
    }

    private static func hashtagEnd(_ units: [UInt16], _ at: Int) -> Int? {
        var end = at + 1
        var digitsOnly = true
        while end < units.count {
            let width = UTF16.isLeadSurrogate(units[end]) && end + 1 < units.count ? 2 : 1
            let scalars = String(decoding: units[end ..< end + width], as: UTF16.self).unicodeScalars
            guard let scalar = scalars.first, scalars.count == 1, isHashtagScalar(scalar) else { break }
            digitsOnly = digitsOnly && ("0" ... "9").contains(scalar)
            end += width
        }
        return (1 ... maxHashtag).contains(end - at - 1) && !digitsOnly ? end : nil
    }

    private static func starts(_ units: [UInt16], _ at: Int, with prefix: String) -> Bool {
        let prefix = Array(prefix.utf16)
        return units.count >= at + prefix.count && Array(units[at ..< at + prefix.count]) == prefix
    }

    private static func urlEnd(_ units: [UInt16], _ at: Int) -> Int? {
        guard starts(units, at, with: "http://") || starts(units, at, with: "https://") else { return nil }
        var end = at
        while end < units.count, !spaces.contains(units[end]) {
            end += 1
        }
        while end > at, trailing.contains(units[end - 1]) {
            end -= 1
        }
        let candidate = String(decoding: units[at ..< end], as: UTF16.self)
        let range = NSRange(location: 0, length: candidate.utf16.count)
        return urlFormat?.firstMatch(in: candidate, range: range) == nil ? nil : end
    }

    private static func end(_ kind: String, _ units: [UInt16], _ at: Int) -> Int? {
        switch kind {
        case "mention": units[at] == 64 ? mentionEnd(units, at) : nil
        case "hashtag": units[at] == 35 ? hashtagEnd(units, at) : nil
        case "url": urlEnd(units, at)
        default: nil
        }
    }

    /// The matches of `kinds` in `text`, in order and never overlapping.
    static func matches(_ text: String, kinds: [String]) -> [Match] {
        let units = Array(text.utf16)
        var found: [Match] = []
        var at = 0
        while at < units.count {
            let next: (String, Int)? = if at == 0 || spaces.contains(units[at - 1]) {
                kinds.lazy.compactMap { kind in end(kind, units, at).map { (kind, $0) } }.first
            } else {
                nil
            }
            if let next {
                let end = next.1
                found.append(Match(
                    kind: next.0, text: String(decoding: units[at ..< end], as: UTF16.self), start: at, end: end
                ))
                at = end
            } else {
                at += 1
            }
        }
        return found
    }

    private static func isLiteral(_ fields: [String: JSONValue]) -> Bool {
        fields.count == 1 && fields["value"] != nil
    }

    /// `actions` with each `{match: field}` replaced by the match's text or kind.
    static func bind(_ actions: JSONValue, match: Match) -> JSONValue {
        func bound(_ value: JSONValue, literal: Bool) -> JSONValue {
            switch value {
            case let .array(items):
                return .array(items.map { bound($0, literal: false) })
            case let .object(fields):
                if isLiteral(fields) { return value }
                if fields.count == 1, case let .string(field)? = fields["match"] {
                    let text = JSONValue.string(field == "kind" ? match.kind : match.text)
                    return literal ? text : .object(["value": text])
                }
                var result: [String: JSONValue] = [:]
                for (key, child) in fields {
                    result[key] = key == "payload"
                        ? child
                        : bound(child, literal: key == "value" && fields["type"] == .string("setState"))
                }
                return .object(result)
            default:
                return value
            }
        }
        return bound(actions, literal: false)
    }

    /// The decoded actions one tap on `match` runs, or nil when they do not decode.
    static func actions(_ onTap: JSONValue, match: Match) -> [PrototypeAction]? {
        guard let data = try? JSONEncoder().encode(bind(onTap, match: match)) else { return nil }
        return try? JSONDecoder().decode([PrototypeAction].self, from: data)
    }
}
