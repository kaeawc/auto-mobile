import Foundation

/// Hand-rolled parser for a plan's top-level `platform:` / `devices:` metadata (no YAML library).
/// Internal (the reference kept it `private`) so the rewrite's tests can assert it directly.
enum PlanMetadataParser {
    static func parse(from yamlContent: String) throws -> PlanMetadata {
        let lines = yamlContent.split(whereSeparator: \.isNewline).map { String($0) }
        var platform: AutoMobilePlanExecutor.PlanPlatform?
        var devicePlatforms: [String: AutoMobilePlanExecutor.PlanPlatform] = [:]
        var deviceLabels: [String] = []
        var hasDevices = false

        var index = 0
        while index < lines.count {
            let line = stripComments(from: lines[index])
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                index += 1
                continue
            }

            let indent = indentationLevel(line)
            if indent == 0 && trimmed.hasPrefix("platform:") {
                let value = trimmed.dropFirst("platform:".count).trimmingCharacters(in: .whitespaces)
                let normalized = unquote(value)
                if let parsed = AutoMobilePlanExecutor.PlanPlatform(rawValue: normalized) {
                    platform = parsed
                } else if !normalized.isEmpty {
                    throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Unknown platform value: \(normalized)")
                }
                index += 1
                continue
            }

            if indent == 0 && trimmed.hasPrefix("devices:") {
                hasDevices = true
                let listIndent = indentOfNextListItem(startingAt: index + 1, lines: lines) ?? (indent + 2)
                index += 1
                var currentLabel: String?
                var currentPlatform: AutoMobilePlanExecutor.PlanPlatform?

                while index < lines.count {
                    let rawLine = stripComments(from: lines[index])
                    if rawLine.trimmingCharacters(in: .whitespaces).isEmpty {
                        index += 1
                        continue
                    }

                    let currentIndent = indentationLevel(rawLine)
                    if currentIndent < listIndent {
                        break
                    }

                    let trimmedLine = rawLine.trimmingCharacters(in: .whitespaces)
                    if currentIndent == listIndent && trimmedLine.hasPrefix("-") {
                        if let label = currentLabel {
                            deviceLabels.append(label)
                        }
                        if let label = currentLabel, let platformValue = currentPlatform {
                            devicePlatforms[label] = platformValue
                        } else if currentLabel != nil || currentPlatform != nil {
                            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                                "Each device entry must include label and platform."
                            )
                        }
                        currentLabel = nil
                        currentPlatform = nil

                        let remainder = trimmedLine.dropFirst().trimmingCharacters(in: .whitespaces)
                        if remainder.isEmpty {
                            index += 1
                            continue
                        }
                        if remainder.contains(":") {
                            let (key, value) = splitKeyValue(remainder)
                            if key == "label" {
                                currentLabel = value
                            } else if key == "platform" {
                                currentPlatform = try parsePlatform(value)
                            } else if key == "name" {
                                currentLabel = value
                            }
                        } else {
                            currentLabel = remainder
                        }
                        index += 1
                        continue
                    }

                    if currentIndent > listIndent {
                        let (key, value) = splitKeyValue(trimmedLine)
                        if key == "label" || key == "name" {
                            currentLabel = value
                        } else if key == "platform" {
                            currentPlatform = try parsePlatform(value)
                        }
                        index += 1
                        continue
                    }

                    index += 1
                }

                if let label = currentLabel {
                    deviceLabels.append(label)
                }
                if let label = currentLabel, let platformValue = currentPlatform {
                    devicePlatforms[label] = platformValue
                } else if currentLabel != nil || currentPlatform != nil {
                    throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                        "Each device entry must include label and platform."
                    )
                }
                continue
            }

            index += 1
        }

        if hasDevices && deviceLabels.isEmpty {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                "Multi-device plans must declare at least one device."
            )
        }

        if hasDevices && devicePlatforms.count != deviceLabels.count {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                "Multi-device plans must declare platform for each device."
            )
        }

        return PlanMetadata(
            platform: platform,
            devicePlatforms: devicePlatforms,
            deviceLabels: deviceLabels,
            hasDevices: hasDevices
        )
    }

    /// Scan a plan's top-level `secretParameters:` declaration for the sensitive key names, tolerating
    /// `${...}` placeholders anywhere (they are literal text to the scanner). MUST run on the RAW,
    /// pre-substitution plan: a substituted value can inject a newline that truncates the declaration,
    /// and a full YAML load chokes on unquoted placeholders in flow collections (issue #6029 review).
    /// Non-throwing — declaring secrets is best-effort metadata, never a hard execution dependency.
    /// Only the `secretParameters:` block is scanned, so unrelated `${...}` in other lists is ignored.
    static func parseSecretParameterKeys(from yamlContent: String) -> Set<String> {
        let lines = yamlContent.split(whereSeparator: \.isNewline).map { String($0) }
        var keys: Set<String> = []
        var index = 0
        while index < lines.count {
            let trimmed = stripComments(from: lines[index]).trimmingCharacters(in: .whitespaces)
            guard indentationLevel(stripComments(from: lines[index])) == 0,
                  trimmed.hasPrefix("secretParameters:")
            else {
                index += 1
                continue
            }

            // Peek at the value with a quote-aware comment strip (a `#` inside a quoted key is literal
            // YAML, not a comment): empty -> block sequence, `[` -> flow sequence, else bare scalar.
            // `lines[index]` is the raw line and begins with the key (indent 0).
            let rawValue = String(lines[index].dropFirst("secretParameters:".count))
            let inline = stripFlowComment(rawValue).trimmingCharacters(in: .whitespaces)
            if !inline.isEmpty {
                if inline.hasPrefix("[") {
                    // A flow value may span multiple physical lines; a single-pass scanner handles the
                    // multiline form, quoted `#`, escaped quotes, trailing comments after `]`, and line
                    // folding — and fails safe toward over-capture (#6097).
                    let (flowKeys, nextIndex) = parseSecretFlowSequence(
                        lines: lines, startIndex: index, firstValue: rawValue
                    )
                    keys.formUnion(flowKeys)
                    index = nextIndex
                    continue
                }
                // Bare inline scalar (no brackets): treat as a single key name.
                keys.formUnion(parseInlineList(inline))
                index += 1
                continue
            }

            index += 1
            // Block sequence: `-` items at ANY indent (flush with the parent key is valid YAML) until
            // the next non-list line, i.e. the next top-level key.
            while index < lines.count {
                let rawTrimmed = stripComments(from: lines[index]).trimmingCharacters(in: .whitespaces)
                if rawTrimmed.isEmpty {
                    index += 1
                    continue
                }
                if !rawTrimmed.hasPrefix("-") {
                    break
                }
                let item = unquote(rawTrimmed.dropFirst().trimmingCharacters(in: .whitespaces))
                if !item.isEmpty {
                    keys.insert(item)
                }
                index += 1
            }
        }
        return keys
    }

    /// Parse a YAML flow list of scalar keys, e.g. `[apiToken, "password"]`, into its trimmed,
    /// unquoted, non-empty elements. Used for the inline form of `secretParameters:`. Commas inside a
    /// quoted item are NOT separators, so `["API,TOKEN"]` yields the single key `API,TOKEN` rather
    /// than splitting it in two (issue #6029 review).
    private static func parseInlineList(_ value: String) -> [String] {
        var inner = value
        if inner.hasPrefix("[") { inner.removeFirst() }
        if inner.hasSuffix("]") { inner.removeLast() }

        var items: [String] = []
        var current = ""
        var activeQuote: Character?
        var escaped = false
        for character in inner {
            if let quote = activeQuote {
                current.append(character)
                // Inside a double-quoted scalar `\"` is a literal quote, not the closing delimiter, so
                // a `,` or `]` after it stays part of the item (#6097).
                if quote == "\"" {
                    if escaped {
                        escaped = false
                    } else if character == "\\" {
                        escaped = true
                    } else if character == "\"" {
                        activeQuote = nil
                    }
                } else if character == "'" {
                    activeQuote = nil
                }
            } else if character == "\"" || character == "'" {
                activeQuote = character
                current.append(character)
            } else if character == "," {
                items.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        items.append(current)

        return items
            .map { unquoteFlowScalar($0.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.isEmpty }
    }

    private static func stripTrailingCarriageReturn(_ line: String) -> String {
        line.hasSuffix("\r") ? String(line.dropLast()) : line
    }

    /// Scan a `secretParameters:` YAML flow sequence that may span multiple physical lines, returning
    /// the declared key names and the index of the next line to resume from. A lenient hand-rolled
    /// scanner (a full YAML load chokes on `${...}` in flow collections — issue #6029). It honors
    /// quotes; double-quote backslash escaping (`\"`, so a `]`/`,`/`"` after it stays literal); quoted
    /// `#` (a `#` inside a scalar is literal — only an unquoted `#` at line start or after whitespace
    /// begins a comment); any content after the closing `]` (ignored — including a trailing comment);
    /// and YAML newline folding inside a double-quoted scalar (a trailing `\` continues the scalar,
    /// dropping the newline; a plain newline folds to a space; continuation indentation is not part of
    /// the value).
    ///
    /// `secretParameters` key names are expected to be literal, simple identifiers. Exotic YAML
    /// encodings (`\xNN`/`\uNNNN` hex/unicode escapes, plain-scalar line folding, CRLF-in-quoted
    /// multiline keys) are handled best-effort here, NOT with full YAML-spec decoding — so a key may be
    /// mis-named. That is made safe at the value layer: `SecretRedaction.secretParameterValues` matches
    /// leniently and, if a declared key still cannot be resolved, over-redacts, so a declared secret's
    /// VALUE is always scrubbed (possibly over-redacting), never leaked. Full decoding is tracked as a
    /// follow-up to #6097.
    ///
    /// FAIL-SAFE: key-name parsing errs toward OVER-capturing for redaction, never dropping a declared
    /// key (which would leak its value). Every non-empty token is kept as a secret key, and an
    /// UNTERMINATED sequence (e.g. from substitution truncation) still yields every token seen (#6097).
    private static func parseSecretFlowSequence(
        lines: [String], startIndex: Int, firstValue: String
    )
        -> (keys: [String], nextIndex: Int)
    {
        var items: [String] = []
        var current = ""
        var depth = 0
        var started = false
        var activeQuote: Character?
        var escaped = false
        var lineIndex = startIndex
        // Drop a trailing CR so a CRLF-authored quoted multiline key does not embed `\r` (#6097).
        var currentLine = stripTrailingCarriageReturn(firstValue)

        while true {
            var previous: Character?
            var inComment = false
            for character in currentLine {
                if inComment { break }
                if let quote = activeQuote {
                    if quote == "\"" {
                        if escaped {
                            current.append(character)
                            escaped = false
                        } else if character == "\\" {
                            escaped = true
                        } else if character == "\"" {
                            activeQuote = nil
                        } else {
                            current.append(character)
                        }
                    } else if character == "'" {
                        activeQuote = nil
                    } else {
                        current.append(character)
                    }
                } else if !started {
                    if character == "[" {
                        started = true
                        depth = 1
                    }
                } else if character == "#" && (previous == nil || previous == " " || previous == "\t") {
                    inComment = true
                } else if character == "\"" || character == "'" {
                    activeQuote = character
                } else if character == "[" {
                    depth += 1
                    current.append(character)
                } else if character == "]" {
                    depth -= 1
                    if depth == 0 {
                        items.append(current)
                        return (finalizeSecretKeys(items), lineIndex + 1)
                    }
                    current.append(character)
                } else if character == ",", depth == 1 {
                    items.append(current)
                    current = ""
                } else {
                    current.append(character)
                }
                previous = character
            }

            // Physical line ended. Fold per YAML inside a double-quoted scalar: a trailing `\`
            // continues it (drop the newline); a plain newline folds to a space. Outside a quote, a
            // plain scalar spanning lines is captured token-per-line (over-capture, fail-safe) instead
            // of blending into one key.
            if activeQuote == "\"", escaped {
                escaped = false
            } else if activeQuote != nil {
                current.append(" ")
            } else if started, !current.trimmingCharacters(in: .whitespaces).isEmpty {
                items.append(current)
                current = ""
            }

            lineIndex += 1
            if lineIndex >= lines.count {
                // Unterminated flow: fail safe — keep every token seen so its value is still redacted.
                items.append(current)
                return (finalizeSecretKeys(items), lineIndex)
            }
            // Drop a trailing CR; inside a quoted scalar the continuation's leading indentation is not
            // part of the value.
            let rawLine = stripTrailingCarriageReturn(lines[lineIndex])
            currentLine = activeQuote != nil
                ? String(rawLine.drop { $0 == " " || $0 == "\t" })
                : rawLine
        }
    }

    /// Trim and drop empties from the scanner's already-decoded flow items (quotes/escapes are
    /// resolved during scanning, so no further unquoting here).
    private static func finalizeSecretKeys(_ items: [String]) -> [String] {
        items
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Remove a trailing YAML line comment from a flow line without stripping a `#` that sits inside a
    /// quoted scalar. Only an unquoted `#` at line start or preceded by whitespace begins a comment
    /// (YAML rule); double-quote backslash escaping is tracked so `\"` does not close the scalar and a
    /// following `#` stays literal (#6097).
    private static func stripFlowComment(_ line: String) -> String {
        var result = ""
        var activeQuote: Character?
        var escaped = false
        var previous: Character?
        for character in line {
            if let quote = activeQuote {
                result.append(character)
                if quote == "\"" {
                    if escaped {
                        escaped = false
                    } else if character == "\\" {
                        escaped = true
                    } else if character == "\"" {
                        activeQuote = nil
                    }
                } else if character == "'" {
                    activeQuote = nil
                }
            } else if character == "#" && (previous == nil || previous == " " || previous == "\t") {
                break
            } else {
                if character == "\"" || character == "'" {
                    activeQuote = character
                }
                result.append(character)
            }
            previous = character
        }
        return result
    }

    /// Unquote a flow-list scalar: a single-quoted scalar is literal, a double-quoted scalar has its
    /// backslash escapes resolved (so `"a\"]b"` yields `a"]b`), matching the escape tracking used to
    /// find the sequence terminator and to split items (#6097).
    private static func unquoteFlowScalar(_ value: String) -> String {
        if value.count >= 2 {
            if value.hasPrefix("\"") && value.hasSuffix("\"") {
                return unescapeDoubleQuoted(String(value.dropFirst().dropLast()))
            }
            if value.hasPrefix("'") && value.hasSuffix("'") {
                return String(value.dropFirst().dropLast())
            }
        }
        return value
    }

    /// Resolve backslash escapes inside a double-quoted YAML scalar: `\` escapes the next character
    /// literally (so `\"` -> `"`, `\\` -> `\`). Sufficient for key names (#6097).
    private static func unescapeDoubleQuoted(_ inner: String) -> String {
        var result = ""
        var escaped = false
        for character in inner {
            if escaped {
                result.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else {
                result.append(character)
            }
        }
        if escaped {
            result.append("\\")
        }
        return result
    }

    private static func parsePlatform(_ value: String) throws -> AutoMobilePlanExecutor.PlanPlatform {
        let normalized = unquote(value)
        guard let platform = AutoMobilePlanExecutor.PlanPlatform(rawValue: normalized) else {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Unknown platform value: \(value)")
        }
        return platform
    }

    private static func indentationLevel(_ line: String) -> Int {
        return line.prefix { $0 == " " }.count
    }

    private static func indentOfNextListItem(startingAt startIndex: Int, lines: [String]) -> Int? {
        var index = startIndex
        while index < lines.count {
            let line = stripComments(from: lines[index])
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                index += 1
                continue
            }
            let indent = indentationLevel(line)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("-") {
                return indent
            }
            if indent == 0 {
                return nil
            }
            index += 1
        }
        return nil
    }

    private static func stripComments(from line: String) -> String {
        guard let hashIndex = line.firstIndex(of: "#") else {
            return line
        }
        return String(line[..<hashIndex])
    }

    private static func splitKeyValue(_ line: String) -> (String, String) {
        let parts = line.split(separator: ":", maxSplits: 1).map { String($0) }
        if parts.count == 2 {
            return (
                parts[0].trimmingCharacters(in: .whitespaces),
                unquote(parts[1].trimmingCharacters(in: .whitespaces))
            )
        }
        return (line.trimmingCharacters(in: .whitespaces), "")
    }

    private static func unquote(_ value: String) -> String {
        if value.count >= 2 {
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                return String(value.dropFirst().dropLast())
            }
        }
        return value
    }
}
