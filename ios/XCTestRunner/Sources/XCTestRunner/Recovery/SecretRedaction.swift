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

    /// Replace every occurrence of each secret value in `text` with the redaction placeholder. Longer
    /// values are replaced first so a secret that contains a shorter one as a substring is fully
    /// masked. Matching is `.literal` (exact code units) because `secretValues` already supplies the
    /// NFC/NFD variants to match.
    static func redact(_ text: String, secretValues: [String]) -> String {
        guard !secretValues.isEmpty else {
            return text
        }
        var redacted = text
        for value in secretValues.sorted(by: { $0.count > $1.count }) where !value.isEmpty {
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
