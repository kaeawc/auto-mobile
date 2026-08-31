/// Best-effort extraction of per-step `tool:` names from a plan's YAML `steps:` list, used to label the
/// "previously succeeded steps" in the recovery prompt. Tolerant by design: the full plan YAML is also
/// handed to the agent, so a missed name degrades to a generic label rather than causing a failure.
public enum PlanStepToolParser {
    public static func toolNames(from yaml: String) -> [String] {
        var names: [String] = []
        var inSteps = false
        var stepsIndent = 0
        var awaitingToolForCurrentItem = false

        for rawLine in yaml.split(whereSeparator: \.isNewline).map(String.init) {
            let line = stripComment(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                continue
            }
            let indent = line.prefix { $0 == " " }.count

            if !inSteps {
                if trimmed == "steps:" || trimmed.hasPrefix("steps:") {
                    inSteps = true
                    stepsIndent = indent
                }
                continue
            }

            // A non-list line at or above the steps key ends the steps block.
            if indent <= stepsIndent, !trimmed.hasPrefix("-") {
                break
            }

            if trimmed.hasPrefix("-") {
                let remainder = trimmed.dropFirst().trimmingCharacters(in: .whitespaces)
                if let tool = toolValue(String(remainder)) {
                    names.append(tool)
                    awaitingToolForCurrentItem = false
                } else {
                    names.append("step")
                    awaitingToolForCurrentItem = true
                }
            } else if awaitingToolForCurrentItem, let tool = toolValue(trimmed), !names.isEmpty {
                names[names.count - 1] = tool
                awaitingToolForCurrentItem = false
            }
        }

        return names
    }

    private static func toolValue(_ text: String) -> String? {
        guard text.hasPrefix("tool:") else {
            return nil
        }
        let value = text.dropFirst("tool:".count).trimmingCharacters(in: .whitespaces)
        if value.isEmpty {
            return nil
        }
        return unquote(String(value))
    }

    private static func stripComment(_ line: String) -> String {
        guard let hashIndex = line.firstIndex(of: "#") else {
            return line
        }
        return String(line[..<hashIndex])
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2 else {
            return value
        }
        if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
            return String(value.dropFirst().dropLast())
        }
        return value
    }
}
