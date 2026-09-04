package dev.jasonpearson.automobile.junit

import java.text.Normalizer

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
 * also scans the RAW plan for the declared secret key names with a placeholder-tolerant line
 * scanner (a full YAML load chokes on `${...}` in flow collections). `internal` — its only consumer
 * is the executor, and `SecretRedactorTest` unit-tests it. Mirrors the iOS `SecretRedaction` /
 * `PlanMetadataParser.parseSecretParameterKeys`.
 */
internal object SecretRedactor {
  const val PLACEHOLDER: String = "***REDACTED***"

  /**
   * Expand the executor-supplied concrete secret strings into the exact forms to scrub: each value
   * in its NFC and NFD Unicode forms, so a decomposed on-screen/error occurrence still matches a
   * composed value (and vice versa). Blank inputs are dropped; the result is deduped preserving
   * order.
   */
  fun secretValues(concreteValues: List<String>): List<String> {
    val values = LinkedHashSet<String>()
    for (value in concreteValues) {
      if (value.isEmpty()) continue
      values.add(value)
      values.add(Normalizer.normalize(value, Normalizer.Form.NFC))
      values.add(Normalizer.normalize(value, Normalizer.Form.NFD))
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
   * Scan a plan's top-level `secretParameters:` declaration for the sensitive key names, tolerating
   * `${...}` placeholders anywhere (they are literal text to the scanner). MUST run on the RAW,
   * pre-substitution plan: a substituted value can inject a newline that truncates the declaration,
   * and a full YAML load throws on unquoted placeholders in flow collections (issue #6029 review).
   * Non-throwing. Only the `secretParameters:` block is scanned, so unrelated `${...}` lists are
   * ignored. Mirrors iOS `PlanMetadataParser.parseSecretParameterKeys`.
   */
  fun parsePlanSecretKeys(planContent: String): Set<String> {
    val lines = planContent.split('\n')
    val keys = LinkedHashSet<String>()
    var index = 0
    while (index < lines.size) {
      val trimmed = stripComments(lines[index]).trim()
      if (
        indentationLevel(stripComments(lines[index])) != 0 ||
          !trimmed.startsWith("secretParameters:")
      ) {
        index++
        continue
      }
      val inline = trimmed.removePrefix("secretParameters:").trim()
      if (inline.isNotEmpty()) {
        // A bracketed flow value may span multiple lines: accumulate continuation lines until the
        // matching `]` before parsing, so `secretParameters: [\n  TOKEN,\n  PASSWORD\n]` is not
        // dropped (#6097). Quotes and `${...}` placeholders are honored exactly as the single-line
        // path does; a full YAML load is deliberately avoided (it chokes on `${...}` flow items).
        if (inline.startsWith("[") && !flowSequenceIsClosed(inline)) {
          val accumulated = StringBuilder(inline)
          index++
          while (index < lines.size && !flowSequenceIsClosed(accumulated.toString())) {
            accumulated.append(' ').append(stripComments(lines[index]).trim())
            index++
          }
          keys.addAll(parseInlineList(accumulated.toString()))
          continue
        }
        keys.addAll(parseInlineList(inline))
        index++
        continue
      }
      index++
      // Block sequence: `-` items at ANY indent (flush with the parent key is valid YAML) until the
      // next non-list line, i.e. the next top-level key.
      while (index < lines.size) {
        val itemTrimmed = stripComments(lines[index]).trim()
        if (itemTrimmed.isEmpty()) {
          index++
          continue
        }
        if (!itemTrimmed.startsWith("-")) break
        val item = unquote(itemTrimmed.removePrefix("-").trim())
        if (item.isNotEmpty()) keys.add(item)
        index++
      }
    }
    return keys
  }

  /**
   * True once [text] contains the `]` that closes its first `[`, honoring quotes so a bracket
   * inside a quoted key (or a `${...}` placeholder, which is literal text here) is not mistaken for
   * the flow delimiter. Used to decide when a multiline flow sequence is complete (#6097).
   */
  private fun flowSequenceIsClosed(text: String): Boolean {
    var depth = 0
    var activeQuote: Char? = null
    for (character in text) {
      when {
        activeQuote != null -> if (character == activeQuote) activeQuote = null
        character == '"' || character == '\'' -> activeQuote = character
        character == '[' -> depth++
        character == ']' -> {
          depth--
          if (depth == 0) return true
        }
      }
    }
    return false
  }

  private fun stripComments(line: String): String {
    val hash = line.indexOf('#')
    return if (hash >= 0) line.substring(0, hash) else line
  }

  private fun indentationLevel(line: String): Int = line.takeWhile { it == ' ' }.length

  private fun unquote(value: String): String {
    if (value.length >= 2) {
      val first = value.first()
      val last = value.last()
      if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
        return value.substring(1, value.length - 1)
      }
    }
    return value
  }

  /**
   * Parse a YAML flow list of scalar keys, e.g. `[apiToken, "password"]`. A comma inside a quoted
   * item is part of the key, not a separator, so `["API,TOKEN"]` yields the single key `API,TOKEN`.
   */
  private fun parseInlineList(value: String): List<String> {
    val inner = value.removePrefix("[").removeSuffix("]")
    val items = mutableListOf<String>()
    val current = StringBuilder()
    var activeQuote: Char? = null
    for (character in inner) {
      when {
        activeQuote != null -> {
          if (character == activeQuote) activeQuote = null
          current.append(character)
        }
        character == '"' || character == '\'' -> {
          activeQuote = character
          current.append(character)
        }
        character == ',' -> {
          items.add(current.toString())
          current.clear()
        }
        else -> current.append(character)
      }
    }
    items.add(current.toString())
    return items.map { unquote(it.trim()) }.filter { it.isNotEmpty() }
  }
}
