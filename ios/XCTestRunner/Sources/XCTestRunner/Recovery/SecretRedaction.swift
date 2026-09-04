import Foundation

/// Redacts sensitive parameter values from any context that will leave the process for a third-party
/// LLM provider during AI-assisted recovery (CWE-200, issue #6029). The base64 `executePlan` payload
/// sent to the LOCAL daemon is intentionally NOT routed through here — the daemon needs the real
/// values to run the plan, and it is not the egress boundary.
///
/// The redactor works on the concrete secret VALUES (not the `${key}` templates): once a plan is
/// substituted, a secret's value can appear in the plan YAML, in the failure error string, and in
/// on-screen text sampled at failure. Replacing every occurrence of each value covers all of those
/// channels uniformly. Mirrors Android's `SecretRedactor`.
enum SecretRedaction {
    static let placeholder = "***REDACTED***"

    /// The values to scrub: the value of every secret key that was actually supplied a non-empty
    /// parameter. Keys with no value (declared secret but never substituted) contribute nothing.
    static func secretValues(keys: Set<String>, parameters: [String: String]) -> [String] {
        keys
            .compactMap { parameters[$0] }
            .filter { !$0.isEmpty }
    }

    /// Replace every occurrence of each secret value in `text` with the redaction placeholder.
    /// Longer values are replaced first so a secret that contains a shorter secret as a substring is
    /// fully masked rather than partially.
    static func redact(_ text: String, secretValues: [String]) -> String {
        guard !secretValues.isEmpty else {
            return text
        }
        var redacted = text
        for value in secretValues.sorted(by: { $0.count > $1.count }) {
            redacted = redacted.replacingOccurrences(of: value, with: placeholder)
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
}
