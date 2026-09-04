package dev.jasonpearson.automobile.junit

import org.yaml.snakeyaml.Yaml

/**
 * Redacts sensitive plan-parameter values from any recovery context that leaves the process for a
 * third-party LLM provider (CWE-200, issue #6029). The base64 `executePlan` payload sent to the
 * LOCAL daemon is intentionally NOT routed through here — the daemon needs the real values to run
 * the plan, and it is not the egress boundary.
 *
 * The redactor works on the concrete secret VALUES (not the `${key}` templates): once a plan is
 * substituted, a secret's value can appear in the plan YAML and in the failure error string, so
 * replacing every occurrence of each value covers those channels uniformly. Mirrors the iOS
 * `SecretRedaction`.
 */
object SecretRedactor {
  const val PLACEHOLDER: String = "***REDACTED***"

  /**
   * The values to scrub: the substituted value of every secret key that was actually supplied a
   * non-blank parameter. Keys with no value contribute nothing. The value is stringified the same
   * way parameter substitution stringifies it, so the scrubbed text matches what was substituted.
   */
  fun secretValues(keys: Set<String>, parameters: Map<String, Any>): List<String> =
    keys
      .mapNotNull { key -> parameters[key]?.let { parameterStringValue(it) } }
      .filter {
        it.isNotEmpty()
      }

  /** Stringify a parameter value exactly as [AutoMobilePlanExecutor] does during substitution. */
  fun parameterStringValue(value: Any): String =
    when (value) {
      is String -> value
      is Enum<*> -> value.name
      else -> value.toString()
    }

  /**
   * Replace every occurrence of each secret value in [text] with [PLACEHOLDER]. Longer values are
   * replaced first so a secret that contains a shorter secret as a substring is fully masked.
   */
  fun redact(text: String, secretValues: List<String>): String {
    if (secretValues.isEmpty()) return text
    var redacted = text
    for (value in secretValues.sortedByDescending { it.length }) {
      redacted = redacted.replace(value, PLACEHOLDER)
    }
    return redacted
  }

  /**
   * A display copy of [parameters] with the values of [secretKeys] masked. Used for debug logging
   * so a secret value is not written to logcat in plaintext (outside #6029's strict LLM-egress
   * scope, but consistent with it).
   */
  fun redactParameters(parameters: Map<String, Any>, secretKeys: Set<String>): Map<String, Any> =
    if (secretKeys.isEmpty()) parameters
    else parameters.mapValues { (key, value) -> if (key in secretKeys) PLACEHOLDER else value }

  /**
   * Parameter keys a plan declares sensitive via its top-level `secretParameters:` list. Unioned
   * with [AutoMobilePlanExecutionOptions.secretParameterKeys] by the executor. Parsing failures
   * yield an empty set — declaring secrets is best-effort metadata, never a hard execution
   * dependency.
   */
  fun parsePlanSecretKeys(planContent: String): Set<String> =
    try {
      val root = Yaml().load<Any?>(planContent)
      val list = (root as? Map<*, *>)?.get("secretParameters") as? List<*> ?: return emptySet()
      list.mapNotNull { it?.toString()?.takeIf { key -> key.isNotBlank() } }.toSet()
    } catch (e: Exception) {
      // A malformed plan is caught and reported by PlanSchemaValidator on the substituted content;
      // here we only need the secret-key hints, so swallow and fall back to the configured set.
      println("Warning: failed to parse secretParameters from plan: ${e.message}")
      emptySet()
    }
}
