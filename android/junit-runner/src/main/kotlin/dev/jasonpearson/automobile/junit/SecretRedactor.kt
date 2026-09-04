package dev.jasonpearson.automobile.junit

import java.text.Normalizer
import org.yaml.snakeyaml.Yaml

/**
 * Redacts sensitive plan-parameter values from any recovery context that leaves the process for a
 * third-party LLM provider (CWE-200, issue #6029). The base64 `executePlan` payload sent to the
 * LOCAL daemon is intentionally NOT routed through here — the daemon needs the real values to run
 * the plan, and it is not the egress boundary.
 *
 * The redactor works on the concrete secret VALUES (not the `${key}` templates): once a plan is
 * substituted, a secret's value can appear in the plan YAML, the failure error, and a substituted
 * tool name, so replacing every occurrence of each value covers those channels uniformly.
 * `internal` — only [AutoMobilePlanExecutor] consumes it. Mirrors the iOS `SecretRedaction`.
 */
internal object SecretRedactor {
  const val PLACEHOLDER: String = "***REDACTED***"

  /**
   * Resolve `${...}` references inside declared secret key NAMES against [parameters], so a plan
   * may parameterize the key it declares (`secretParameters: [${SECRET_KEY}]`). A literal key
   * resolves to itself. Keeps iOS and Android agreeing on the effective key set.
   */
  fun resolveKeyNames(keys: Set<String>, parameters: Map<String, Any>): Set<String> =
    keys.map { resolve(it, parameters) }.toSet()

  /**
   * The concrete strings to scrub for the given (already key-name-resolved) secret keys. For each
   * key we scrub BOTH its raw parameter value AND its fully-resolved value (a secret whose value
   * embeds another `${param}` lands in the plan as the resolved form), each in its NFC and NFD
   * Unicode forms so a decomposed on-screen/error occurrence still matches. Blank values contribute
   * nothing. The value is stringified the same way parameter substitution stringifies it.
   */
  fun secretValues(keys: Set<String>, parameters: Map<String, Any>): List<String> {
    val values = LinkedHashSet<String>()
    for (key in keys) {
      val raw = parameters[key]?.let { parameterStringValue(it) } ?: continue
      if (raw.isEmpty()) continue
      val resolved = resolve(raw, parameters)
      for (base in listOf(raw, resolved)) {
        if (base.isNotEmpty()) values.addAll(normalizationForms(base))
      }
    }
    return values.toList()
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
   * [String.replace] matches literal code units; [secretValues] already supplies the NFC/NFD
   * variants.
   */
  fun redact(text: String, secretValues: List<String>): String {
    if (secretValues.isEmpty()) return text
    var redacted = text
    for (value in secretValues.sortedByDescending { it.length }) {
      if (value.isNotEmpty()) redacted = redacted.replace(value, PLACEHOLDER)
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

  /**
   * Fully resolve `${key}` references in [value] against [parameters], iterating to a fixpoint so a
   * value that embeds another parameter (which itself embeds another) resolves completely. Bounded
   * by the parameter count so a reference cycle terminates instead of looping.
   */
  private fun resolve(value: String, parameters: Map<String, Any>): String {
    if (!value.contains("\${")) return value
    var current = value
    repeat(parameters.size + 1) {
      var next = current
      for ((key, replacement) in parameters) {
        next = next.replace("\${$key}", parameterStringValue(replacement))
      }
      if (next == current) return current
      current = next
    }
    return current
  }

  /** [value] plus its canonical NFC and NFD forms (deduped). */
  private fun normalizationForms(value: String): List<String> =
    linkedSetOf(
        value,
        Normalizer.normalize(value, Normalizer.Form.NFC),
        Normalizer.normalize(value, Normalizer.Form.NFD),
      )
      .toList()
}
