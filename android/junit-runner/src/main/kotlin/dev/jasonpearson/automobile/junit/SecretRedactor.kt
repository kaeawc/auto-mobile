package dev.jasonpearson.automobile.junit

import java.text.Normalizer
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

/**
 * Redacts sensitive plan-parameter values from any recovery context that leaves the process for a
 * third-party LLM provider (CWE-200, issue #6029). The base64 `executePlan` payload sent to the
 * LOCAL daemon is intentionally NOT routed through here — the daemon needs the real values to run
 * the plan, and it is not the egress boundary.
 *
 * This object does NOT resolve `${...}` placeholders: substitution is owned by
 * [AutoMobilePlanExecutor], the single source of truth for what actually landed in the plan
 * (issue #6029 review — an independent fixpoint could mismatch the executor's single ordered pass,
 * or blow up on a self-referential value). The executor hands over the concrete substituted secret
 * strings; this object expands each into its Unicode NFC/NFD forms and scrubs every occurrence. It
 * also scans the RAW plan for the declared secret key names: `${...}` placeholders are swapped for
 * YAML-safe sentinels so snakeyaml can spec-decode the key scalars (escapes, folding, CRLF), then
 * the sentinels are mapped back — falling back to a placeholder-tolerant line scanner when the
 * substituted plan is not loadable (issue #6141). `internal` — its only consumer is the executor,
 * and `SecretRedactorTest` unit-tests it. Mirrors the iOS `SecretRedaction` /
 * `PlanMetadataParser.parseSecretParameterKeys`.
 */
internal object SecretRedactor {
  const val PLACEHOLDER: String = "***REDACTED***"

  /** Matches a `${...}` substitution placeholder (non-greedy, no nested braces). */
  private val PLACEHOLDER_PATTERN = Regex("""\$\{[^}]*}""")

  // A sentinel that survives YAML as a plain scalar (letters/digits only, no escapes) and is
  // exceedingly unlikely to collide with a real key. The index keeps each placeholder distinct so
  // it maps back to its exact original text.
  private const val SENTINEL_PREFIX = "AMx6141xPLACEHOLDERx"
  private const val SENTINEL_SUFFIX = "xEND"

  /**
   * Expand the executor-supplied concrete secret strings into the exact forms to scrub: each value
   * in its NFC and NFD Unicode forms (so a decomposed on-screen/error occurrence still matches a
   * composed value and vice versa) and, for each, its JSON-string-escaped form (the recovery loop's
   * tool/observe results are JSON — issue #6094 — so a secret with a JSON-special character appears
   * only escaped there). Blank inputs are dropped; the result is deduped preserving order.
   */
  fun secretValues(concreteValues: List<String>): List<String> {
    val values = LinkedHashSet<String>()
    for (value in concreteValues) {
      if (value.isEmpty()) continue
      for (form in
        listOf(
          value,
          Normalizer.normalize(value, Normalizer.Form.NFC),
          Normalizer.normalize(value, Normalizer.Form.NFD),
        )) {
        // The recovery loop's tool/observe results are JSON (issue #6094), so a secret containing a
        // JSON-special character (`"`, `\`, newline, tab, CR) appears only escaped there and the
        // literal replace would miss it. Android additionally reserializes the enclosing MCP
        // `JsonElement` over an already-encoded `content[].text` (`DefaultMCPClient.callTool`), so
        // the value can be DOUBLE-escaped. Scrub raw + single + double; a no-op escape equals its
        // predecessor and is deduped away.
        var encoded = form
        repeat(3) {
          values.add(encoded)
          encoded = jsonEscape(encoded)
        }
      }
    }
    return values.toList()
  }

  /**
   * The JSON-string-escaped form of [value] (its inner content, without surrounding quotes),
   * covering the short escapes every JSON serializer agrees on plus lowercase `\uXXXX` for other
   * control characters. Used to also scrub a secret that reaches the recovery loop inside a JSON
   * tool/observe result (#6094).
   */
  fun jsonEscape(value: String): String = buildString {
    for (character in value) {
      when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        '\b' -> append("\\b")
        '\u000C' -> append("\\f")
        else ->
          if (character < ' ') append("\\u" + character.code.toString(16).padStart(4, '0'))
          else append(character)
      }
    }
  }

  /** Stringify a parameter value exactly as [AutoMobilePlanExecutor] does during substitution. */
  fun parameterStringValue(value: Any): String =
    when (value) {
      is String -> value
      is Enum<*> -> value.name
      else -> value.toString()
    }

  /**
   * Replace every occurrence of each secret value in [text] with [PLACEHOLDER], guaranteeing that
   * NO declared value survives in the result. Longer values are replaced first so a secret that
   * contains a shorter secret as a substring is fully masked. [String.replace] matches literal code
   * units; [secretValues] already supplies the NFC/NFD variants.
   *
   * A single pass is not enough: substituting the marker can SYNTHESIZE another declared value out
   * of the marker plus its surrounding context (declared `abc` and `X***REDACTED***Y`, text `XabcY`
   * — #6146), or reintroduce a declared value that is a substring of the marker (declared
   * `REDACTED` and `abc`). So the pass repeats until one finds nothing (the proof that no declared
   * value is present), bounded by the number of values plus one. If the bound is exhausted and the
   * last pass's output still contains a declared value, the whole text is over-redacted to the
   * marker alone — or to the empty string when the marker itself contains a declared value.
   * Over-redact, never leak.
   */
  fun redact(text: String, secretValues: List<String>): String {
    val ordered = secretValues.filter { it.isNotEmpty() }.sortedByDescending { it.length }
    if (ordered.isEmpty()) return text
    var redacted = text
    repeat(ordered.size + 1) { redacted = replaceEach(redacted, ordered) ?: return redacted }
    // The final permitted pass may itself have produced a secret-free result; keep that rather
    // than discarding the whole context.
    if (ordered.none { redacted.contains(it) }) return redacted
    return if (ordered.any { PLACEHOLDER.contains(it) }) "" else PLACEHOLDER
  }

  /**
   * One longest-first replacement pass over [text], or `null` when no value of [ordered] occurs in
   * it (the fixpoint). A value that is itself a substring of the placeholder (e.g. `REDACTED` or
   * `***REDACTED***`) is removed rather than substituted, since substituting the placeholder would
   * reintroduce it (#6094).
   */
  private fun replaceEach(text: String, ordered: List<String>): String? {
    var result = text
    var changed = false
    for (value in ordered) {
      if (!result.contains(value)) continue
      result = result.replace(value, if (PLACEHOLDER.contains(value)) "" else PLACEHOLDER)
      changed = true
    }
    return if (changed) result else null
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
   * The parameter VALUES to scrub for a set of declared secret key names, matched leniently so an
   * exotically-encoded key name cannot leak its value. For each declared key: a key that still
   * contains a backslash (a YAML escape the scanner did not spec-decode) is low-confidence and
   * forces over-redaction — its raw form must not be trusted to exact-match a DECOY parameter while
   * the real value hides under the decoded name. Otherwise an exact `parameters[key]` is taken;
   * failing that, any parameter whose key normalizes equal (case-folded, with
   * backslashes/quotes/whitespace/CR removed) is taken; and if a declared key still resolves to
   * nothing, EVERY parameter value is taken (over-redaction). `secretParameters` key names are
   * expected to be literal identifiers — this is the fail-safe backstop for YAML encodings the flow
   * scanner does not fully decode (`\xNN`/`\uNNNN` escapes, folding, CRLF): a declared secret's
   * value is always scrubbed (possibly over-redacting), never leaked (#6097). Full decoding is a
   * follow-up (#6141).
   */
  fun secretParameterValues(declaredKeys: Set<String>, parameters: Map<String, Any>): List<String> =
    SecretParameterMatcher.values(declaredKeys, parameters)

  /**
   * Scan a plan's top-level `secretParameters:` declaration for the sensitive key names, tolerating
   * `${...}` placeholders anywhere (they are literal text). MUST run on the RAW, pre-substitution
   * plan: a substituted value can inject a newline that truncates the declaration (issue #6029
   * review).
   *
   * Primary path (issue #6141): replace every `${...}` placeholder with a YAML-safe sentinel so a
   * real YAML load does not choke on unquoted placeholders in flow collections, run the plan
   * through snakeyaml — which decodes escapes (`\xNN`, `\uNNNN`, `\U........`, `\n`, `\t`, `\0`,
   * `\/`, …), multi-line folding, and CRLF to the spec-correct key name — then map the sentinels
   * back to their original `${...}` text. Falls back to the placeholder-tolerant line scanner
   * ([parsePlanSecretKeysBestEffort]) whenever the substituted plan is not loadable as a mapping
   * (e.g. a value injected a newline that truncated the document), so the redactor never drops a
   * declared key. Non-throwing. Mirrors iOS `PlanMetadataParser.parseSecretParameterKeys`.
   */
  fun parsePlanSecretKeys(planContent: String): Set<String> {
    val sentinels = mutableListOf<Pair<String, String>>()
    val substituted =
      PLACEHOLDER_PATTERN.replace(planContent) { match ->
        val sentinel = "$SENTINEL_PREFIX${sentinels.size}$SENTINEL_SUFFIX"
        sentinels.add(sentinel to match.value)
        sentinel
      }

    val decoded = runCatching {
      // SafeConstructor: build only maps/lists/scalars, never arbitrary Java types — a redactor
      // must not become a YAML-deserialization gadget for untrusted plan content. Escapes and
      // folding are resolved by the reader, so they still decode under SafeConstructor.
      val root = Yaml(SafeConstructor(LoaderOptions())).load<Any?>(substituted)
      val declaration = (root as? Map<*, *>)?.get("secretParameters")
      extractKeyNames(declaration, sentinels)
    }
      .getOrNull()

    // A null result means the substituted plan was not a loadable mapping (snakeyaml threw or the
    // top level was not a map). Fall back to the best-effort scanner so a declared key is never
    // dropped. A non-null empty set means the plan parsed cleanly with no `secretParameters:`.
    return decoded ?: parsePlanSecretKeysBestEffort(planContent)
  }

  /**
   * Turn a snakeyaml-decoded `secretParameters` value into its set of key names, mapping any
   * substitution sentinel back to its original `${...}` text. A scalar declaration is treated as a
   * single key; a sequence contributes each stringified element. Returns null when the declaration
   * is absent so the caller can distinguish "no secrets" (empty set) from "not a mapping"
   * (fallback).
   */
  private fun extractKeyNames(
    declaration: Any?,
    sentinels: List<Pair<String, String>>,
  ): Set<String> {
    val keys = LinkedHashSet<String>()
    when (declaration) {
      null -> {}
      is List<*> ->
        for (element in declaration) {
          if (element == null) continue
          val key = restorePlaceholders(parameterStringValue(element), sentinels)
          if (key.isNotEmpty()) keys.add(key)
        }
      else -> {
        val key = restorePlaceholders(parameterStringValue(declaration), sentinels)
        if (key.isNotEmpty()) keys.add(key)
      }
    }
    return keys
  }

  private fun restorePlaceholders(value: String, sentinels: List<Pair<String, String>>): String {
    var restored = value
    for ((sentinel, original) in sentinels) {
      if (restored.contains(sentinel)) restored = restored.replace(sentinel, original)
    }
    return restored
  }

  /**
   * Best-effort, placeholder-tolerant line scanner for the declared secret key names. Retained as
   * the fallback for plans that snakeyaml cannot load as a mapping (e.g. a substituted value that
   * injects a document-truncating newline). Over-captures rather than dropping tokens, so the
   * redactor stays fail-safe toward over-redaction. Does NOT spec-decode escapes/folding — that is
   * the snakeyaml primary path's job (issue #6141).
   */
  internal fun parsePlanSecretKeysBestEffort(planContent: String): Set<String> =
    SecretKeyFallbackParser.parse(planContent)
}
