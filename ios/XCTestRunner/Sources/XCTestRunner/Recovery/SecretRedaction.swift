import Foundation

/// Redacts sensitive parameter values from any context that will leave the process for a third-party
/// LLM provider during AI-assisted recovery (CWE-200, issue #6029). The base64 `executePlan` payload
/// sent to the LOCAL daemon is intentionally NOT routed through here — the daemon needs the real
/// values to run the plan, and it is not the egress boundary.
///
/// This type does NOT resolve `${...}` placeholders: substitution is owned by the executor, which is
/// the single source of truth for what actually landed in the plan (issue #6029 review — an
/// independent fixpoint could mismatch the executor's single ordered pass, or blow up on a
/// self-referential value). The executor hands over the concrete substituted secret strings; this
/// type expands each into its Unicode NFC/NFD forms and scrubs every occurrence. `internal` — its
/// only consumer is the executor, and `SecretRedactionTests` unit-tests it directly. Mirrors
/// Android's `SecretRedactor`.
enum SecretRedaction {
    static let placeholder = "***REDACTED***"

    /// Expand the executor-supplied concrete secret strings into the exact byte forms to scrub: each
    /// value in its NFC and NFD Unicode forms, so a decomposed on-screen/error occurrence still
    /// matches a composed value (and vice versa). Blank inputs are dropped. Dedup is by UTF-16 code
    /// units, NOT `Set<String>`, because Swift string equality is canonical and would collapse the
    /// distinct forms we deliberately keep.
    static func secretValues(_ concreteValues: [String]) -> [String] {
        var result: [String] = []
        var seen: Set<[UInt16]> = []
        for value in concreteValues where !value.isEmpty {
            for form in normalizationForms(of: value) where seen.insert(Array(form.utf16)).inserted {
                result.append(form)
            }
        }
        return result
    }

    /// Replace every occurrence of each secret value in `text` with the redaction placeholder. Values
    /// are replaced longest-first — by UTF-16 code-unit length, so a decomposed form (more code units
    /// than its composed twin) and any shorter secret that is a substring of a longer one are masked
    /// whole, with no combining-mark or substring residue. Matching is `.literal` (exact code units)
    /// because `secretValues` already supplies the NFC/NFD variants. Matches Android's `length`-desc
    /// ordering (Kotlin `String.length` is a UTF-16 count).
    static func redact(_ text: String, secretValues: [String]) -> String {
        guard !secretValues.isEmpty else {
            return text
        }
        var redacted = text
        for value in secretValues.sorted(by: { $0.utf16.count > $1.utf16.count }) where !value.isEmpty {
            redacted = redacted.replacingOccurrences(of: value, with: placeholder, options: [.literal])
        }
        return redacted
    }

    /// Redact the sampled UI strings and observe-error that feed the recovery prompt. A secret can
    /// surface on screen (a token echoed into a field) or in the observe error, so these channels are
    /// scrubbed too. Returns `nil` unchanged when there is no observation.
    static func redact(
        _ observation: FailureObservationSummary?,
        secretValues: [String]
    )
        -> FailureObservationSummary?
    {
        guard let observation = observation, !secretValues.isEmpty else {
            return observation
        }
        return FailureObservationSummary(
            capturedAtMs: observation.capturedAtMs,
            observeError: observation.observeError.map { redact($0, secretValues: secretValues) },
            awaitTimeout: observation.awaitTimeout,
            visibleTextsSample: observation.visibleTextsSample?.map { redact($0, secretValues: secretValues) },
            resourceIdsSample: observation.resourceIdsSample?.map { redact($0, secretValues: secretValues) }
        )
    }

    /// The parameter VALUES to scrub for a set of declared secret key names, matched leniently so an
    /// exotically-encoded key name cannot leak its value. For each declared key: an exact
    /// `parameters[key]` is taken; failing that, any parameter whose key normalizes equal (case-folded,
    /// with backslashes/quotes/whitespace/CR removed) is taken; and if a declared key still resolves to
    /// nothing, EVERY parameter value is taken (over-redaction). `secretParameters` key names are
    /// expected to be literal identifiers — this is the fail-safe backstop for YAML encodings the flow
    /// scanner does not fully decode (`\xNN`/`\uNNNN` escapes, folding, CRLF): a declared secret's value
    /// is always scrubbed (possibly over-redacting), never leaked (#6097). Full decoding is a follow-up.
    static func secretParameterValues(
        declaredKeys: Set<String>,
        parameters: [String: String]
    )
        -> [String]
    {
        guard !declaredKeys.isEmpty else {
            return []
        }
        var values: [String] = []
        var hasUnresolvedKey = false
        for key in declaredKeys {
            if let exact = parameters[key], !exact.isEmpty {
                values.append(exact)
                continue
            }
            let target = normalizeKey(key)
            var matched = false
            for (paramKey, paramValue) in parameters where normalizeKey(paramKey) == target {
                if !paramValue.isEmpty {
                    values.append(paramValue)
                }
                matched = true
            }
            if !matched {
                hasUnresolvedKey = true
            }
        }
        if hasUnresolvedKey {
            // A declared secret could not be located even leniently (e.g. a `\xNN` hex-escaped key the
            // scanner did not spec-decode). Over-redact every parameter value so it cannot leak (#6097).
            for value in parameters.values where !value.isEmpty {
                values.append(value)
            }
        }
        return values
    }

    /// Case-folded key with backslashes, quotes, and whitespace/CR removed — the lenient key-identity
    /// used to match a mis-encoded declared secret key to a parameter (#6097).
    private static func normalizeKey(_ key: String) -> String {
        var result = ""
        for scalar in key.lowercased().unicodeScalars {
            switch scalar {
            case "\\", "\"", "'", " ", "\t", "\r", "\n":
                continue
            default:
                result.unicodeScalars.append(scalar)
            }
        }
        return result
    }

    /// `value` plus its canonical NFC and NFD forms, distinct by UTF-16 code units (Swift string `!=`
    /// is canonical and would treat every form as equal).
    private static func normalizationForms(of value: String) -> [String] {
        var forms = [value]
        var seen: Set<[UInt16]> = [Array(value.utf16)]
        for candidate in [value.precomposedStringWithCanonicalMapping, value.decomposedStringWithCanonicalMapping]
            where seen.insert(Array(candidate.utf16)).inserted
        {
            forms.append(candidate)
        }
        return forms
    }
}
