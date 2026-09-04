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
        var secretParameterKeys: Set<String> = []

        var index = 0
        while index < lines.count {
            let line = stripComments(from: lines[index])
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                index += 1
                continue
            }

            let indent = indentationLevel(line)
            if indent == 0 && trimmed.hasPrefix("secretParameters:") {
                let inline = trimmed.dropFirst("secretParameters:".count).trimmingCharacters(in: .whitespaces)
                if !inline.isEmpty {
                    secretParameterKeys.formUnion(parseInlineList(inline))
                    index += 1
                    continue
                }
                index += 1
                while index < lines.count {
                    let raw = stripComments(from: lines[index])
                    let rawTrimmed = raw.trimmingCharacters(in: .whitespaces)
                    if rawTrimmed.isEmpty {
                        index += 1
                        continue
                    }
                    // A block sequence's `-` items may sit at ANY indent, including flush with the
                    // parent key (indent 0) — valid YAML that snakeyaml (Android) accepts. Only a
                    // non-list line ends the sequence, i.e. the next top-level key. Breaking on
                    // indent 0 dropped every key of a flush list and silently disabled redaction.
                    if !rawTrimmed.hasPrefix("-") {
                        break
                    }
                    let item = unquote(rawTrimmed.dropFirst().trimmingCharacters(in: .whitespaces))
                    if !item.isEmpty {
                        secretParameterKeys.insert(item)
                    }
                    index += 1
                }
                continue
            }

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
            hasDevices: hasDevices,
            secretParameterKeys: secretParameterKeys
        )
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
        for character in inner {
            if let quote = activeQuote {
                if character == quote {
                    activeQuote = nil
                }
                current.append(character)
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
            .map { unquote($0.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.isEmpty }
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
