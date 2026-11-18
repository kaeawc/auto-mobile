import Foundation

/// Standalone deep-link matching, independent of spec decoding and runtime routing.
public enum PrototypeLinkMatcher {
    public struct Entry: Sendable {
        public let path: String
        public let query: [String: String]
        public let usedCaptures: Set<String>?

        public init(path: String, query: [String: String] = [:], usedCaptures: Set<String>? = nil) {
            self.path = path
            self.query = query
            self.usedCaptures = usedCaptures
        }
    }

    public struct Match: Codable, Equatable, Sendable {
        public let entryIndex: Int
        public let captures: [String: String]
        public let query: [String: JSONValue]
    }

    public struct TableError: Equatable, Sendable {
        public let index: Int
        public let code: String
        public let message: String
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "\\A(?:\(pattern))\\z", options: .regularExpression) != nil
    }

    private static func validName(_ name: String) -> Bool {
        matches(name, "[A-Za-z][A-Za-z0-9_]{0,31}")
    }

    private static func validType(_ type: String) -> Bool {
        matches(type, "(string|int|number|boolean)\\??")
    }

    private static func captureName(_ segment: String) -> String? {
        guard segment.hasPrefix("{"), segment.hasSuffix("}") else { return nil }
        let name = String(segment.dropFirst().dropLast())
        return validName(name) ? name : nil
    }

    private static func patternSegments(_ path: String) -> [String]? {
        if path == "/" { return [] }
        guard path.hasPrefix("/") else { return nil }
        let segments = path.dropFirst().components(separatedBy: "/")
        return segments.allSatisfy { matches($0, "[A-Za-z0-9._~-]+") || captureName($0) != nil }
            ? segments : nil
    }

    private static func queryValid(_ entry: Entry, captures: Set<String>) -> Bool {
        entry.query.allSatisfy { name, type in
            validName(name) && !captures.contains(name) && validType(type)
        }
    }

    private static func entryErrors(_ entry: Entry, index: Int) -> [TableError] {
        guard let segments = patternSegments(entry.path) else {
            return [.init(index: index, code: "badPattern", message: "Invalid link path pattern")]
        }
        var errors: [TableError] = []
        var captures: Set<String> = []
        for segment in segments {
            guard let name = captureName(segment) else { continue }
            if !captures.insert(name).inserted {
                errors.append(.init(index: index, code: "duplicateCapture", message: "Duplicate capture: \(name)"))
            }
            if let used = entry.usedCaptures, !used.contains(name) {
                errors.append(.init(index: index, code: "unusedCapture", message: "Unused capture: \(name)"))
            }
        }
        for (name, type) in entry.query.sorted(by: { $0.key < $1.key })
            where !validName(name) || captures.contains(name) || !validType(type)
        {
            errors.append(.init(index: index, code: "badQuery", message: "Invalid query declaration: \(name)"))
        }
        return errors
    }

    /// All errors in entry order; the table limit is reported once at index 32.
    public static func validateLinkTable(_ entries: [Entry]) -> [TableError] {
        var errors: [TableError] = []
        var shapes: Set<String> = []
        for (index, entry) in entries.enumerated() {
            if index == 32 {
                errors.append(.init(
                    index: index,
                    code: "tooManyEntries",
                    message: "At most 32 link entries are allowed"
                ))
            }
            errors.append(contentsOf: entryErrors(entry, index: index))
            guard let segments = patternSegments(entry.path) else { continue }
            let shape = segments.map { captureName($0) == nil ? $0 : "{}" }.joined(separator: "/")
            if !shapes.insert(shape).inserted {
                errors.append(.init(index: index, code: "duplicatePattern", message: "Duplicate link pattern shape"))
            }
        }
        return errors
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48 ... 57: byte - 48
        case 65 ... 70: byte - 55
        case 97 ... 102: byte - 87
        default: nil
        }
    }

    private static func decode(_ text: String, plus: Bool) -> String? {
        let source = Array(text.utf8)
        var bytes: [UInt8] = []
        var index = 0
        while index < source.count {
            let byte = source[index]
            if byte == 37 {
                guard index + 2 < source.count, let high = hex(source[index + 1]),
                      let low = hex(source[index + 2])
                else {
                    return nil
                }
                bytes.append(high * 16 + low)
                index += 3
            } else {
                bytes.append(plus && byte == 43 ? 32 : byte)
                index += 1
            }
        }
        // Strict standard-library decoding preserves a leading BOM, which Foundation strips.
        // swiftlint:disable:next optional_data_string_conversion
        return String(validating: bytes, as: UTF8.self)
    }

    private struct Parts {
        let segments: [String]
        let query: [String: String]
    }

    private static func urlParts(_ url: String) -> Parts? {
        let clean = url.components(separatedBy: "#")[0]
        guard let separator = clean.range(of: "://"), separator.lowerBound != clean.startIndex else { return nil }
        let scheme = clean[..<separator.lowerBound].lowercased()
        guard matches(scheme, "[a-z][a-z0-9+.-]*") else { return nil }
        let rest = String(clean[separator.upperBound...])
        let question = rest.firstIndex(of: "?")
        let rawPath = question.map { String(rest[..<$0]) } ?? rest
        var path = rawPath
        if scheme == "http" || scheme == "https" {
            path = rawPath.firstIndex(of: "/").map { String(rawPath[$0...]) } ?? ""
        }
        if path.hasPrefix("/") { path.removeFirst() }
        if path.hasSuffix("/") { path.removeLast() }
        let segments = path.isEmpty ? [] : path.components(separatedBy: "/")
        guard !segments.contains(""), !rawPath.hasSuffix("//") else { return nil }
        var decoded: [String] = []
        for segment in segments {
            guard let part = decode(segment, plus: false), !part.isEmpty else { return nil }
            decoded.append(part)
        }
        let query = question.map { String(rest[rest.index(after: $0)...]) } ?? ""
        return Parts(segments: decoded, query: queryPairs(query))
    }

    private static func queryPairs(_ text: String) -> [String: String] {
        var pairs: [String: String] = [:]
        for pair in text.components(separatedBy: "&") where !pair.isEmpty {
            let equal = pair.firstIndex(of: "=")
            let rawKey = equal.map { String(pair[..<$0]) } ?? pair
            let rawValue = equal.map { String(pair[pair.index(after: $0)...]) } ?? ""
            guard let key = decode(rawKey, plus: true), let value = decode(rawValue, plus: true) else { continue }
            if pairs[key] == nil { pairs[key] = value }
        }
        return pairs
    }

    private static func queryValue(_ value: String, type: String) -> JSONValue? {
        switch type {
        case "string": return .string(value)
        case "boolean": return value == "true" ? .bool(true) : value == "false" ? .bool(false) : nil
        case "int":
            guard matches(value, "-?[0-9]+"), let number = Double(value), number.isFinite,
                  abs(number) <= 9_007_199_254_740_991 else { return nil }
            return .number(number)
        case "number":
            guard matches(value, "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?"),
                  let number = Double(value), number.isFinite else { return nil }
            return .number(number)
        default: return nil
        }
    }

    private static func matchEntry(_ entry: Entry, parts: Parts, index: Int) -> Match? {
        guard let pattern = patternSegments(entry.path), pattern.count == parts.segments.count else { return nil }
        var captures: [String: String] = [:]
        for (index, segment) in pattern.enumerated() {
            if let name = captureName(segment) {
                guard captures[name] == nil else { return nil }
                captures[name] = parts.segments[index]
            } else if segment != parts.segments[index] {
                return nil
            }
        }
        guard queryValid(entry, captures: Set(captures.keys)) else { return nil }
        var query: [String: JSONValue] = [:]
        for (name, declaration) in entry.query {
            guard let value = parts.query[name] else {
                if !declaration.hasSuffix("?") { return nil }
                continue
            }
            let type = declaration.hasSuffix("?") ? String(declaration.dropLast()) : declaration
            guard let parsed = queryValue(value, type: type) else { return nil }
            query[name] = parsed
        }
        return Match(entryIndex: index, captures: captures, query: query)
    }

    /// First matching entry, including query coercion; malformed paths never match.
    public static func match(_ url: String, entries: [Entry]) -> Match? {
        guard let parts = urlParts(url) else { return nil }
        for (index, entry) in entries.enumerated() {
            if let result = matchEntry(entry, parts: parts, index: index) { return result }
        }
        return nil
    }
}
