import Foundation
import Yams

/// Substitutes once on Yams' tree, including mapping keys, without letting values add YAML structure.
/// Quoted/block scalars remain strings; plain-safe replacements retain implicit scalar typing.
/// Yams reads `{a:"${x}"}` as one plain key with an empty value; substitution follows that tree.
enum PlanParameterSubstitutor {
    static func substituteText(in text: String, parameters: [String: String]) -> String {
        guard !parameters.isEmpty else { return text }
        return PlanYamlPlaceholders.replaceTokens(in: text) { token in
            parameters[String(token.dropFirst(2).dropLast())] ?? token
        }
    }

    static func substitute(in plan: String, parameters: [String: String]) throws -> String {
        guard !parameters.isEmpty else { return plan }
        let placeholders = PlanYamlPlaceholders(plan)
        do {
            guard let root = try Yams.compose(yaml: placeholders.yaml) else { return plan }
            // Validate even when no known token occurs: malformed plans must fail before redaction.
            guard placeholders.tokens.keys.contains(where: {
                parameters[String($0.dropFirst(2).dropLast())] != nil
            }) else { return plan }
            let replaced = try substitute(root, placeholders: placeholders, parameters: parameters)
            // Keep secret values contiguous and printable Unicode literal for recovery redaction.
            return try Yams.serialize(node: replaced, width: -1, allowUnicode: true)
        } catch let error as AutoMobilePlanExecutor.ExecutorError {
            throw error
        } catch {
            throw AutoMobilePlanExecutor.ExecutorError.invalidPlan("Invalid YAML: \(error)")
        }
    }

    private static func substitute(
        _ node: Node, placeholders: PlanYamlPlaceholders, parameters: [String: String]
    )
        throws -> Node
    {
        switch node {
        case let .mapping(mapping):
            let pairs = try mapping.map { pair in
                try (
                    substitute(
                        pair.key,
                        placeholders: placeholders,
                        parameters: parameters
                    ),
                    substitute(
                        pair.value,
                        placeholders: placeholders,
                        parameters: parameters
                    )
                )
            }
            return .mapping(Node.Mapping(pairs, mapping.tag, .block, mapping.mark, mapping.anchor))
        case let .sequence(sequence):
            let values = try sequence.map {
                try substitute($0, placeholders: placeholders, parameters: parameters)
            }
            return .sequence(Node.Sequence(values, sequence.tag, .block, sequence.mark, sequence.anchor))
        case let .scalar(scalar):
            let original = placeholders.restore(scalar.string)
            if scalar.style == .folded {
                for (key, replacement) in parameters {
                    if let token = placeholders.tokens["${\(key)}"], scalar.string.contains(token),
                       replacement.unicodeScalars.contains { $0 == "\n" || $0 == "\r" }
                    {
                        throw AutoMobilePlanExecutor.ExecutorError.invalidPlan(
                            "Plan line \(scalar.mark?.line ?? 1): a parameter value with a line break cannot be substituted into a "
                                + "folded (>) block scalar, which would fold the break into a space. Use a literal (|) "
                                + "block scalar or a double-quoted scalar (\"${name}\")."
                        )
                    }
                }
            }
            let value = placeholders.expand(scalar.string, parameters: parameters)
            guard original != value else {
                return .scalar(Node.Scalar(original, scalar.tag, scalar.style, scalar.mark, scalar.anchor))
            }
            if scalar.style == .plain, let plain = plainScalar(value) {
                return .scalar(Node.Scalar(value, plain.tag, .plain, scalar.mark, scalar.anchor))
            }
            // Explicit string style prevents numeric-looking quoted values from being re-resolved.
            return .scalar(Node.Scalar(value, Tag(.str), .doubleQuoted, scalar.mark, scalar.anchor))
        case .alias:
            return node
        }
    }

    /// Ask the structured parser whether the entire replacement is one unquoted scalar. No YAML
    /// punctuation rules are duplicated here, and parsing a candidate never exposes it to the plan.
    private static func plainScalar(_ value: String) -> Node? {
        guard !value.isEmpty, !value.unicodeScalars.contains(where: {
            $0.value < 0x20 || $0.value == 0x7F || $0 == "\u{85}" || $0 == "\u{2028}" || $0 == "\u{2029}"
        }) else { return nil }
        do {
            guard let node = try Yams.compose(yaml: value), let scalar = node.scalar,
                  scalar.style == .plain, scalar.string == value
            else { return nil }
            return node
        } catch {
            // Expected for values containing YAML punctuation; emit them as strings instead.
            print("[AutoMobile][DEBUG] Parameter requires YAML string quoting (\(type(of: error)))")
            return nil
        }
    }
}
