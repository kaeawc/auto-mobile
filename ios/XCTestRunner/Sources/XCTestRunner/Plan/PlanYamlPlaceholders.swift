import Foundation

/// Protects placeholder tokens, not YAML syntax. Private-use sentinels are plain scalars even in
/// flow collections; all YAML structure and escaping are handled by Yams after this pass.
struct PlanYamlPlaceholders: Sendable {
    let yaml: String
    let tokens: [String: String]

    init(_ source: String) {
        // Exclude both literal and YAML-escaped spellings: Yams decodes escapes before restore.
        let lowercased = source.lowercased()
        let reserved = (0xE000 ... 0xF8FF).lazy.compactMap { Unicode.Scalar($0) }.first { scalar in
            !source.unicodeScalars.contains(scalar)
                && !lowercased.contains("\\u" + String(format: "%04x", scalar.value))
                && !lowercased.contains("\\u" + String(format: "%08x", scalar.value))
        }
        // A decoded literal cannot be longer than the source that encoded it.
        let prefix = reserved.map(String.init)
            ?? String(repeating: "\u{E000}", count: source.unicodeScalars.count + 1)
        var tokens: [String: String] = [:]
        let protected = Self.replaceTokens(in: source) { token in
            if let existing = tokens[token] { return existing }
            let sentinel = prefix + String(tokens.count) + "\u{E001}"
            tokens[token] = sentinel
            return sentinel
        }
        yaml = protected
        self.tokens = tokens
    }

    func restore(_ text: String) -> String {
        expand(text, parameters: [:])
    }

    /// Replace sentinel occurrences in one pass: inserted values (including sentinels or `${...}`)
    /// are never visited again. Iterate Unicode scalars so combining marks do not hide a token edge.
    func expand(_ text: String, parameters: [String: String]) -> String {
        let entries = tokens.map { token, sentinel in
            (Array(sentinel.unicodeScalars), parameters[String(token.dropFirst(2).dropLast())] ?? token)
        }
        let scalars = Array(text.unicodeScalars)
        var output = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            if let entry = entries.first(where: {
                index + $0.0.count <= scalars.count
                    && scalars[index ..< index + $0.0.count].elementsEqual($0.0)
            }) {
                output.append(contentsOf: entry.1.unicodeScalars)
                index += entry.0.count
            } else {
                output.append(scalars[index])
                index += 1
            }
        }
        return String(output)
    }

    static func replaceTokens(in text: String, transform: (String) -> String) -> String {
        let scalars = Array(text.unicodeScalars)
        var output = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            if scalars[index] == "$", index + 1 < scalars.count, scalars[index + 1] == "{",
               let end = scalars[(index + 2)...].firstIndex(of: "}"),
               !scalars[(index + 2) ..< end].contains("{")
            {
                let token = String(String.UnicodeScalarView(scalars[index ... end]))
                output.append(contentsOf: transform(token).unicodeScalars)
                index = end + 1
            } else {
                output.append(scalars[index])
                index += 1
            }
        }
        return String(output)
    }
}
