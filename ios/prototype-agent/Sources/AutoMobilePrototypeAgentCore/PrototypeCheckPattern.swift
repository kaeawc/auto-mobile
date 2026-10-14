import Foundation

/// The host checks the portable grammar. The agent re-checks its limits and translates the
/// ASCII shorthand classes and dot to ECMAScript semantics before compiling with ICU.
/// At most two variable quantifiers (max > min) are allowed in the entire pattern. A group
/// repeated more than once cannot transitively contain a variable quantifier or alternation;
/// fixed {n} repetitions remain legal. These limits reject backtracking blowups.
enum PrototypeCheckPattern {
    static let maxValueLength = 4096

    static func withinLimits(_ pattern: String) -> Bool {
        guard pattern.utf16.count <= 128 else { return false }
        var scanner = LimitScanner(pattern)
        return scanner.check()
    }

    // A group repeated more than once must not transitively contain alternation or any
    // variable quantifier (max > min). At most two variable quantifiers are allowed in the
    // entire pattern to reject polynomial/exponential backtracking blowups. Fixed {n}
    // repetitions remain legal. Re-check these rules before any ICU compilation.
    private struct LimitScanner {
        private let scalars: [Unicode.Scalar]
        private var cursor = 0
        private var variableCount = 0
        private var valid = true

        init(_ pattern: String) { scalars = Array(pattern.unicodeScalars) }

        mutating func check() -> Bool {
            _ = body(group: false)
            return valid && cursor == scalars.count
        }

        private var next: Unicode.Scalar? {
            cursor < scalars.count ? scalars[cursor] : nil
        }

        private mutating func body(group: Bool) -> (variable: Bool, alternation: Bool) {
            var result = (variable: false, alternation: false)
            while let char = next, valid {
                cursor += 1
                if char == ")" {
                    if !group { valid = false }
                    return result
                }
                if char == "|" { result.alternation = true; continue }
                var atom = (variable: false, alternation: false)
                if char == "\\" {
                    guard next != nil else { valid = false; return result }
                    cursor += 1
                } else if char == "[" {
                    while let member = next, member != "]" {
                        cursor += 1
                        if member == "\\", next != nil { cursor += 1 }
                    }
                    guard next == "]" else { valid = false; return result }
                    cursor += 1
                } else if char == "(" {
                    if next == "?" {
                        cursor += 1
                        guard next == ":" else { valid = false; return result }
                        cursor += 1
                    }
                    atom = body(group: true)
                } else if "*+?{}]".unicodeScalars.contains(char) {
                    valid = false
                    return result
                }
                if let quantifier = quantifier() {
                    if char == "^" || char == "$" { valid = false }
                    if quantifier.max > 1, atom.variable || atom.alternation { valid = false }
                    if quantifier.variable {
                        variableCount += 1
                        if variableCount > 2 { valid = false }
                        result.variable = true
                    }
                }
                result.variable = result.variable || atom.variable
                result.alternation = result.alternation || atom.alternation
            }
            if group { valid = false }
            return result
        }

        private mutating func number() -> Int? {
            var value = 0
            var found = false
            while let char = next, ("0" ... "9").contains(char) {
                found = true
                cursor += 1
                value = value * 10 + Int(char.value - 48)
                if value > 100 { valid = false; return nil }
            }
            return found ? value : nil
        }

        private mutating func quantifier() -> (max: Int, variable: Bool)? {
            let maximum: Int
            let variable: Bool
            switch next {
            case "?": cursor += 1; maximum = 1; variable = true
            case "*", "+": cursor += 1; maximum = Int.max; variable = true
            case "{":
                cursor += 1
                guard let minimum = number() else { valid = false; return nil }
                maximum = next == "," ? upperBound() : minimum
                guard valid, next == "}", minimum <= maximum else { valid = false; return nil }
                cursor += 1
                variable = maximum > minimum
            default: return nil
            }
            if let char = next, "?+*{".unicodeScalars.contains(char) { valid = false }
            return (maximum, variable)
        }

        private mutating func upperBound() -> Int {
            cursor += 1
            return number() ?? Int.max
        }
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
