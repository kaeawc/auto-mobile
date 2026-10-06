import Foundation

/// Applies `${name}` plan parameters to a plan's YAML source so a value lands as exactly the text the
/// test supplied, whatever characters it contains (issue #10093).
///
/// The old pass spliced the raw value into the source, so what the daemon parsed depended on the
/// value: a backslash became an escape inside `"..."`, ` #` became a comment in a bare scalar, and a
/// line break could add steps. XCTestRunner has no YAML library (see `PlanMetadataParser`), so this
/// walks the source with a small scanner that knows which scalar context each placeholder sits in
/// and writes the value in that context's own safe form:
///
/// - inside `"..."`: the value is YAML-escaped (`\`, `"`, control characters, line breaks);
/// - inside `'...'`: `'` is doubled; a value holding a line break or control character rewrites the
///   scalar as `"..."` instead (a single-quoted scalar cannot carry them);
/// - an unquoted scalar: a value that is a plain-safe scalar (`500`, `true`, `hunter2`) is spliced
///   raw, so numeric and boolean tool arguments keep the YAML type they always had; any other value
///   (`shoes #1`, `size: large`, leading space, line break, ...) rewrites the whole scalar as
///   `"..."`, so it is a string;
/// - a block scalar (`|`, `>`): the value is spliced raw, line breaks re-indented;
/// - a comment: left untouched.
///
/// Every placeholder is replaced in ONE pass over the original text, so a value that itself
/// contains `${other}` is never expanded again. Unknown placeholders stay literal.
///
/// Mirrors the Android runner's `PlanParameterSubstitution`, which does the same on a parsed YAML
/// tree. Known limit (the scanner is not a full YAML parser): an unquoted scalar that continues on a
/// following line cannot be rewritten as `"..."`, so a non-plain-safe value in one throws
/// `invalidPlan` instead of guessing — write the placeholder in a double-quoted scalar.
enum PlanParameterSubstitutor {
    /// Substitute into a plain string (secret key names, the redaction path's bare `${key}`): a
    /// single pass that never rescans substituted text.
    static func substituteText(in text: String, parameters: [String: String]) -> String {
        guard !parameters.isEmpty else {
            return text
        }
        let placeholders = Placeholders(parameters)
        return placeholders.expand(Array(text.unicodeScalars)[...]).text
    }

    /// Substitute into a plan's YAML source.
    static func substitute(in plan: String, parameters: [String: String]) throws -> String {
        guard !parameters.isEmpty else {
            return plan
        }
        var scanner = PlanScanner(placeholders: Placeholders(parameters))
        let lines = plan.components(separatedBy: "\n")
        var output: [String] = []
        output.reserveCapacity(lines.count)
        for (number, line) in lines.enumerated() {
            try output.append(scanner.process(line: Array(line.unicodeScalars), lineNumber: number + 1))
        }
        return output.joined(separator: "\n")
    }
}

// MARK: - Placeholder table

private struct Placeholders {
    private let entries: [(token: [Unicode.Scalar], value: String)]

    init(_ parameters: [String: String]) {
        // Longest token first, then lexicographic, so matching is deterministic.
        entries = parameters
            .map { (token: Array("${\($0.key)}".unicodeScalars), value: $0.value) }
            .sorted {
                $0.token.count != $1.token.count
                    ? $0.token.count > $1.token.count
                    : String(String.UnicodeScalarView($0.token)) < String(String.UnicodeScalarView($1.token))
            }
    }

    /// The known placeholder starting at `index`, if any.
    func match(_ scalars: [Unicode.Scalar], at index: Int) -> (length: Int, value: String)? {
        guard scalars[index] == "$", index + 1 < scalars.count, scalars[index + 1] == "{" else {
            return nil
        }
        for entry in entries where index + entry.token.count <= scalars.count {
            if scalars[index ..< index + entry.token.count].elementsEqual(entry.token) {
                return (entry.token.count, entry.value)
            }
        }
        return nil
    }

    /// Replace every known placeholder in `scalars` in one pass; `transform` shapes each value.
    func expand(
        _ slice: ArraySlice<Unicode.Scalar>,
        transform: (String) -> String = { $0 }
    )
        -> (text: String, replaced: Bool)
    {
        let scalars = Array(slice)
        var out = String.UnicodeScalarView()
        var replaced = false
        var index = 0
        while index < scalars.count {
            if let found = match(scalars, at: index) {
                out.append(contentsOf: transform(found.value).unicodeScalars)
                index += found.length
                replaced = true
            } else {
                out.append(scalars[index])
                index += 1
            }
        }
        return (String(out), replaced)
    }
}

// MARK: - YAML scalar forms

private enum YAMLScalar {
    /// `value` as the inside of a double-quoted YAML scalar. Short escapes and lowercase `\u00xx`
    /// match the JSON escaping the recovery redactor already scrubs.
    static func doubleQuotedBody(_ value: String) -> String {
        var out = ""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\u{85}": out += "\\N"
            case "\u{2028}": out += "\\L"
            case "\u{2029}": out += "\\P"
            case "\u{FEFF}": out += "\\uFEFF"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F {
                    out += "\\u" + String(format: "%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out
    }

    static func doubleQuoted(_ value: String) -> String {
        "\"" + doubleQuotedBody(value) + "\""
    }

    /// True when `value` cannot be represented inside a single-quoted scalar.
    static func needsDoubleQuotes(_ value: String) -> Bool {
        value.unicodeScalars.contains { isLineBreakOrControl($0) }
    }

    /// True when `value` can be written as an unquoted scalar and read back as that same text (or the
    /// number/boolean/null it spells), in a block context or — with `flow` — inside `[...]`/`{...}`.
    static func isPlainSafe(_ value: String, flow: Bool) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard let first = scalars.first, let last = scalars.last else {
            return false
        }
        if isSpace(first) || isSpace(last) || scalars.contains(where: isLineBreakOrControl) {
            return false
        }
        if ",[]{}#&*!|>'\"%@`".unicodeScalars.contains(first) {
            return false
        }
        if "-?:".unicodeScalars.contains(first), scalars.count == 1 || isSpace(scalars[1]) {
            return false
        }
        if last == ":" {
            return false
        }
        for index in scalars.indices {
            let scalar = scalars[index]
            let next = index + 1 < scalars.count ? scalars[index + 1] : nil
            if scalar == ":", next.map(isSpace) ?? true { return false }
            if scalar == "#", index > 0, isSpace(scalars[index - 1]) { return false }
            if flow, ",[]{}".unicodeScalars.contains(scalar) { return false }
        }
        return true
    }

    static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
        scalar == " " || scalar == "\t" || scalar == "\r"
    }

    static func isLineBreakOrControl(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value < 0x20 || scalar
            .value == 0x7F || scalar == "\u{85}" || scalar == "\u{2028}" || scalar == "\u{2029}"
    }
}

// MARK: - Line scanner

private enum QuoteKind {
    case double
    case single
}

private struct PlanScanner {
    let placeholders: Placeholders
    private var blockParentIndent: Int?
    private var openQuote: QuoteKind?
    private var flowDepth = 0

    init(placeholders: Placeholders) {
        self.placeholders = placeholders
    }

    /// Per-line cursor state.
    private struct Cursor {
        let line: [Unicode.Scalar]
        let number: Int
        var index = 0
        var output: [Unicode.Scalar] = []
        /// A `-`, `?`, `:` or flow indicator just opened a node, so a scalar here starts one.
        var atNodeStart = false
        var lastDashColumn: Int?
        var firstNodeColumn: Int?
        var sawValueIndicator = false

        init(line: [Unicode.Scalar], number: Int) {
            self.line = line
            self.number = number
        }

        func peek(_ offset: Int = 0) -> Unicode.Scalar? {
            index + offset < line.count ? line[index + offset] : nil
        }

        var nextIsSpaceOrEnd: Bool {
            peek(1).map(YAMLScalar.isSpace) ?? true
        }
    }

    mutating func process(line: [Unicode.Scalar], lineNumber: Int) throws -> String {
        if let parent = blockParentIndent {
            if isBlank(line) || indentation(of: line) > parent {
                return expandBlockLine(line)
            }
            blockParentIndent = nil
        }
        var cursor = Cursor(line: line, number: lineNumber)
        if let kind = openQuote {
            try continueQuote(kind, &cursor)
        }
        while cursor.index < line.count {
            try scanNext(&cursor)
        }
        return String(String.UnicodeScalarView(cursor.output))
    }

    // MARK: Dispatch

    private mutating func scanNext(_ cursor: inout Cursor) throws {
        guard let scalar = cursor.peek() else { return }
        if YAMLScalar.isSpace(scalar) {
            copy(&cursor)
        } else if scalar == "#", cursor.index == 0 || YAMLScalar.isSpace(cursor.line[cursor.index - 1]) {
            cursor.output += cursor.line[cursor.index...]
            cursor.index = cursor.line.count
        } else if scalar == "\"" {
            markNode(&cursor)
            copy(&cursor)
            try continueQuote(.double, &cursor)
        } else if scalar == "'" {
            markNode(&cursor)
            try scanSingleQuoted(&cursor)
        } else if "[{".unicodeScalars.contains(scalar) {
            markNode(&cursor)
            flowDepth += 1
            copy(&cursor)
            cursor.atNodeStart = true
        } else if "]}".unicodeScalars.contains(scalar) {
            flowDepth = max(0, flowDepth - 1)
            copy(&cursor)
            cursor.atNodeStart = false
        } else if scalar == ",", flowDepth > 0 {
            copy(&cursor)
            cursor.atNodeStart = true
        } else if "-?:".unicodeScalars.contains(scalar), cursor.nextIsSpaceOrEnd {
            noteIndicator(scalar, &cursor)
            copy(&cursor)
        } else if "&*!".unicodeScalars.contains(scalar) {
            copyProperty(&cursor)
        } else if "|>".unicodeScalars.contains(scalar), cursor.atNodeStart, flowDepth == 0 {
            openBlockScalar(&cursor)
        } else {
            try scanPlain(&cursor)
        }
    }

    private func copy(_ cursor: inout Cursor) {
        cursor.output.append(cursor.line[cursor.index])
        cursor.index += 1
    }

    private func markNode(_ cursor: inout Cursor) {
        if cursor.firstNodeColumn == nil { cursor.firstNodeColumn = cursor.index }
    }

    private func noteIndicator(_ scalar: Unicode.Scalar, _ cursor: inout Cursor) {
        if scalar == "-" { cursor.lastDashColumn = cursor.index }
        if scalar == ":" { cursor.sawValueIndicator = true }
        cursor.atNodeStart = true
    }

    /// `&anchor`, `*alias`, `!tag`: copied through to the next space; the node still follows.
    private func copyProperty(_ cursor: inout Cursor) {
        while let scalar = cursor.peek(), !YAMLScalar.isSpace(scalar) {
            copy(&cursor)
        }
    }

    private mutating func openBlockScalar(_ cursor: inout Cursor) {
        let indent = indentation(of: cursor.line)
        blockParentIndent =
            cursor.sawValueIndicator
                ? (cursor.firstNodeColumn ?? indent)
                : (cursor.lastDashColumn ?? indent)
        cursor.output += cursor.line[cursor.index...]
        cursor.index = cursor.line.count
    }

    // MARK: Plain scalars

    private mutating func scanPlain(_ cursor: inout Cursor) throws {
        markNode(&cursor)
        let start = cursor.index
        let end = plainScalarEnd(cursor)
        var trimmed = end
        while trimmed > start, YAMLScalar.isSpace(cursor.line[trimmed - 1]) {
            trimmed -= 1
        }
        let token = cursor.line[start ..< trimmed]
        let endsAsKey = end < cursor.line.count && cursor.line[end] == ":"

        let expanded = placeholders.expand(token)
        if !expanded.replaced {
            cursor.output += token
        } else if YAMLScalar.isPlainSafe(expanded.text, flow: flowDepth > 0) {
            cursor.output += expanded.text.unicodeScalars
        } else if cursor.atNodeStart || endsAsKey {
            cursor.output += YAMLScalar.doubleQuoted(expanded.text).unicodeScalars
        } else {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                "Plan line \(cursor.number): a parameter value that is not a plain scalar cannot be "
                    + "substituted into a multi-line unquoted scalar. Write the placeholder in a "
                    + "double-quoted scalar (\"${name}\")."
            )
        }
        cursor.output += cursor.line[trimmed ..< end]
        cursor.index = end
        cursor.atNodeStart = false
    }

    /// Index one past the plain scalar starting at the cursor (before trimming trailing space).
    private func plainScalarEnd(_ cursor: Cursor) -> Int {
        let line = cursor.line
        var index = cursor.index
        while index < line.count {
            if let close = placeholderEnd(line, at: index) {
                index = close
                continue
            }
            let scalar = line[index]
            let next = index + 1 < line.count ? line[index + 1] : nil
            if scalar == "#", index > cursor.index, YAMLScalar.isSpace(line[index - 1]) { break }
            if scalar == ":",
               next.map({ YAMLScalar.isSpace($0) || (flowDepth > 0 && ",]}[{".unicodeScalars.contains($0)) }) ?? true
            {
                break
            }
            if flowDepth > 0, ",[]{}".unicodeScalars.contains(scalar) { break }
            index += 1
        }
        return index
    }

    /// One past a whole `${...}` at `index` (known or not), so its braces never end a scalar.
    private func placeholderEnd(_ line: [Unicode.Scalar], at index: Int) -> Int? {
        if let found = placeholders.match(line, at: index) {
            return index + found.length
        }
        guard line[index] == "$", index + 1 < line.count, line[index + 1] == "{" else { return nil }
        guard let close = line[(index + 2)...].firstIndex(of: "}") else { return nil }
        return close + 1
    }

    // MARK: Quoted scalars

    /// Scan a double-quoted body from the cursor (just after the opening quote, or from the start of
    /// a continuation line) to the closing quote or end of line, escaping each substituted value.
    private mutating func continueQuote(_ kind: QuoteKind, _ cursor: inout Cursor) throws {
        openQuote = kind
        while cursor.index < cursor.line.count {
            let scalar = cursor.line[cursor.index]
            if kind == .double, scalar == "\\" {
                copy(&cursor)
                if cursor.index < cursor.line.count { copy(&cursor) }
            } else if kind == .double, scalar == "\"" {
                copy(&cursor)
                closeQuote(&cursor)
                return
            } else if kind == .single, scalar == "'" {
                copy(&cursor)
                if cursor.peek() == "'" {
                    copy(&cursor)
                } else {
                    closeQuote(&cursor)
                    return
                }
            } else if let found = placeholders.match(cursor.line, at: cursor.index) {
                try appendQuotedValue(found.value, kind: kind, &cursor)
                cursor.index += found.length
            } else {
                copy(&cursor)
            }
        }
    }

    private mutating func closeQuote(_ cursor: inout Cursor) {
        openQuote = nil
        cursor.atNodeStart = false
    }

    private func appendQuotedValue(_ value: String, kind: QuoteKind, _ cursor: inout Cursor) throws {
        switch kind {
        case .double:
            cursor.output += YAMLScalar.doubleQuotedBody(value).unicodeScalars
        case .single:
            // Only reachable on a multi-line single-quoted scalar, where the opening quote is
            // already on an earlier line and the scalar cannot be rewritten.
            if YAMLScalar.needsDoubleQuotes(value) {
                throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                    "Plan line \(cursor.number): a parameter value with a line break or control "
                        + "character cannot be substituted into a multi-line single-quoted scalar. "
                        + "Write the placeholder in a double-quoted scalar (\"${name}\")."
                )
            }
            cursor.output += value.replacingOccurrences(of: "'", with: "''").unicodeScalars
        }
    }

    /// A single-quoted scalar opening at the cursor. When it closes on this line it is handled whole,
    /// so a value a single-quoted scalar cannot carry can turn it into a double-quoted one.
    private mutating func scanSingleQuoted(_ cursor: inout Cursor) throws {
        let line = cursor.line
        guard let close = singleQuoteClose(line, from: cursor.index + 1) else {
            copy(&cursor)
            try continueQuote(.single, &cursor)
            return
        }
        let raw = Array(line[(cursor.index + 1) ..< close])
        let decoded = String(String.UnicodeScalarView(raw)).replacingOccurrences(of: "''", with: "'")
        let expanded = placeholders.expand(Array(decoded.unicodeScalars)[...])
        if !expanded.replaced {
            cursor.output += line[cursor.index ... close]
        } else if YAMLScalar.needsDoubleQuotes(expanded.text) {
            cursor.output += YAMLScalar.doubleQuoted(expanded.text).unicodeScalars
        } else {
            cursor.output += ("'" + expanded.text.replacingOccurrences(of: "'", with: "''") + "'").unicodeScalars
        }
        cursor.index = close + 1
        cursor.atNodeStart = false
    }

    /// Index of the closing `'` at or after `index`, honouring the `''` escape; nil if unterminated.
    private func singleQuoteClose(_ line: [Unicode.Scalar], from start: Int) -> Int? {
        var index = start
        while index < line.count {
            if line[index] == "'" {
                if index + 1 < line.count, line[index + 1] == "'" {
                    index += 2
                    continue
                }
                return index
            }
            index += 1
        }
        return nil
    }

    // MARK: Block scalars

    /// A block scalar's content is raw text: splice the value, re-indenting its line breaks so they
    /// stay inside the scalar. CRLF and lone CR become LF.
    private func expandBlockLine(_ line: [Unicode.Scalar]) -> String {
        let indent = String(String.UnicodeScalarView(line.prefix { $0 == " " }))
        let expanded = placeholders.expand(line[...]) { value in
            value
                .replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\r", with: "\n")
                .replacingOccurrences(of: "\n", with: "\n" + indent)
        }
        return expanded.text
    }

    // MARK: Line helpers

    private func isBlank(_ line: [Unicode.Scalar]) -> Bool {
        line.allSatisfy(YAMLScalar.isSpace)
    }

    private func indentation(of line: [Unicode.Scalar]) -> Int {
        line.prefix { $0 == " " }.count
    }
}
