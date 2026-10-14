import Foundation

/// The host checks the portable grammar. The agent re-checks its limits and translates the
/// ASCII shorthand classes and dot to ECMAScript semantics before compiling with ICU.
enum PrototypeCheckPattern {
    static let maxValueLength = 4096

    static func withinLimits(_ pattern: String) -> Bool {
        guard pattern.utf16.count <= 128 else { return false }
        let scalars = Array(pattern.unicodeScalars)
        var escaped = false
        var inClass = false
        for (index, scalar) in scalars.enumerated() {
            if escaped { escaped = false; continue }
            if scalar == "\\" { escaped = true; continue }
            if scalar == "[" { inClass = true }
            if scalar == "]" { inClass = false }
            if scalar == "{", !inClass {
                var number = 0
                for next in scalars.dropFirst(index + 1) {
                    if ("0" ... "9").contains(next) {
                        number = number * 10 + Int(next.value - 48)
                        if number > 100 { return false }
                    } else if next == "," {
                        number = 0
                    } else {
                        break
                    }
                }
            }
        }
        return true
    }

    static func matches(_ pattern: String, _ value: String) -> Bool {
        guard withinLimits(pattern) else { return false }
        return wholeMatch(source(pattern), value, maxLength: maxValueLength)
    }

    static func wholeMatch(_ pattern: String, _ value: String, maxLength: Int? = nil) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: "^(?:\(pattern))$", options: []) else { return false }
        // A range preserves a surrogate split by the cap, as JS slice does. Decoding the UTF-16
        // prefix to a new Swift String would replace that surrogate with U+FFFD.
        let range = NSRange(location: 0, length: min(value.utf16.count, maxLength ?? value.utf16.count))
        if range.length < value.utf16.count {
            let units = Array(value.utf16.prefix(range.length))
            if let last = units.last, (0xD800 ... 0xDBFF).contains(last) {
                // NSRegularExpression's Swift API cannot accept an unpaired surrogate, and a
                // region ending inside a pair does not match that unit. NSString's Foundation
                // regex API preserves the raw UTF-16 prefix and uses the same ICU expression.
                let prefix = NSString(characters: units, length: units.count)
                return prefix.range(of: regex.pattern, options: .regularExpression, range: range) == range
            }
        }
        return regex.firstMatch(in: value, options: [], range: range)?.range == range
    }

    private static func source(_ pattern: String) -> String {
        let classes = [
            "d": "0-9", "w": "A-Za-z0-9_", "s": " \\t\\r\\n\\f\\u000B",
            "D": "\\u0000-\\u002F\\u003A-\\U0010FFFF",
            "W": "\\u0000-\\u002F\\u003A-\\u0040\\u005B-\\u005E\\u0060\\u007B-\\U0010FFFF",
            "S": "\\u0000-\\u0008\\u000E-\\u001F\\u0021-\\U0010FFFF",
        ]
        var result = ""
        var inClass = false
        var escaped = false
        for scalar in pattern.unicodeScalars {
            let char = String(scalar)
            if escaped {
                if let body = classes[char] {
                    result += inClass ? body : "[\(body)]"
                } else {
                    result += char == "-" && !inClass ? "-" : "\\\(char)"
                }
                escaped = false
            } else if scalar == "\\" {
                escaped = true
            } else {
                switch scalar {
                case "[":
                    result += inClass ? "\\[" : "["
                    inClass = true
                case "]":
                    inClass = false
                    result += char
                case "&": result += inClass ? "\\&" : char
                case ".": result += inClass ? char : "[^\\r\\n\\u2028\\u2029]"
                case "$": result += inClass ? char : "\\z"
                case "^": result += inClass ? char : "\\A"
                default: result += char
                }
            }
        }
        return result
    }
}
