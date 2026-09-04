import Foundation

/// Redacts sensitive parameter values from any context that will leave the process for a third-party
/// LLM provider during AI-assisted recovery (CWE-200, issue #6029). The base64 `executePlan` payload
/// sent to the LOCAL daemon is intentionally NOT routed through here — the daemon needs the real
/// values to run the plan, and it is not the egress boundary.
///
/// The redactor works on the concrete secret VALUES (not the `${key}` templates): once a plan is
/// substituted, a secret's value can appear in the plan YAML, the failure error, a substituted tool
/// name, and on-screen text sampled at failure. Replacing every occurrence of each value covers all of
/// those channels uniformly. `internal` — only the executor consumes it. Mirrors Android's
/// `SecretRedactor`.
enum SecretRedaction {
    static let placeholder = "***REDACTED***"

    /// Resolve `${...}` references inside declared secret key NAMES against `parameters`, so a plan may
    /// parameterize the key it declares (`secretParameters: [${SECRET_KEY}]`). A literal key resolves
    /// to itself. Keeps iOS and Android agreeing on the effective key set.
    static func resolveKeyNames(_ keys: Set<String>, parameters: [String: String]) -> Set<String> {
        Set(keys.map { resolve($0, parameters: parameters) })
    }

    /// The concrete strings to scrub for the given (already key-name-resolved) secret keys. For each
    /// key we scrub BOTH its raw parameter value AND its fully-resolved value (a secret whose value
    /// embeds another `${param}` lands in the plan as the resolved form, issue #6029 review), each in
    /// its NFC and NFD Unicode forms so a decomposed on-screen/error occurrence still matches. Empty
    /// values contribute nothing.
    static func secretValues(keys: Set<String>, parameters: [String: String]) -> [String] {
        var result: [String] = []
        // Dedup by exact UTF-16 code units, NOT by `Set<String>`: Swift string equality is canonical,
        // so a `Set` would collapse the NFC and NFD variants we deliberately keep distinct.
        var seen: Set<[UInt16]> = []
        for key in keys {
            guard let raw = parameters[key], !raw.isEmpty else {
                continue
            }
            let resolved = resolve(raw, parameters: parameters)
            for base in [raw, resolved] where !base.isEmpty {
                for form in normalizationForms(of: base) where seen.insert(Array(form.utf16)).inserted {
                    result.append(form)
                }
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

    /// Fully resolve `${key}` references in `value` against `parameters`, iterating to a fixpoint so a
    /// value that embeds another parameter (which itself embeds another) resolves completely. Bounded
    /// by the parameter count so a reference cycle terminates instead of looping.
    private static func resolve(_ value: String, parameters: [String: String]) -> String {
        guard value.contains("${") else {
            return value
        }
        var current = value
        for _ in 0 ... parameters.count {
            var next = current
            for (key, replacement) in parameters {
                next = next.replacingOccurrences(of: "${\(key)}", with: replacement)
            }
            if next == current {
                break
            }
            current = next
        }
        return current
    }

    /// `value` plus its canonical NFC and NFD forms, so a `.literal` scrub matches the secret
    /// regardless of the Unicode normalization it arrives in. Distinctness is compared by UTF-16 code
    /// units because Swift string `!=` is canonical and would treat every form as equal.
    private static func normalizationForms(of value: String) -> [String] {
        let valueUnits = Array(value.utf16)
        var forms = [value]
        var seen: Set<[UInt16]> = [valueUnits]
        for candidate in [value.precomposedStringWithCanonicalMapping, value.decomposedStringWithCanonicalMapping]
            where seen.insert(Array(candidate.utf16)).inserted
        {
            forms.append(candidate)
        }
        return forms
    }
}
