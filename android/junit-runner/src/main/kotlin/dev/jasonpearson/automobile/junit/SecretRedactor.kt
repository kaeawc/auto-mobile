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
   * Replace every occurrence of each secret value in [text] with [PLACEHOLDER]. Longer values are
   * replaced first so a secret that contains a shorter secret as a substring is fully masked.
   * [String.replace] matches literal code units; [secretValues] already supplies the NFC/NFD
   * variants.
   */
  fun redact(text: String, secretValues: List<String>): String {
    if (secretValues.isEmpty()) return text
    var redacted = text
    for (value in secretValues.sortedByDescending { it.length }) {
      if (value.isEmpty()) continue
      // If the secret is itself a substring of the placeholder (e.g. a secret value of "REDACTED"
      // or "***REDACTED***"), substituting the placeholder would reintroduce the secret — so remove
      // it instead, guaranteeing it cannot survive in the result (#6094).
      val replacement = if (PLACEHOLDER.contains(value)) "" else PLACEHOLDER
      redacted = redacted.replace(value, replacement)
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
  fun secretParameterValues(
    declaredKeys: Set<String>,
    parameters: Map<String, Any>,
  ): List<String> {
    if (declaredKeys.isEmpty()) return emptyList()
    val values = mutableListOf<String>()
    var hasUnresolvedKey = false
    for (key in declaredKeys) {
      if (key.contains('\\')) {
        // A key that still contains a backslash carries a YAML escape the flow scanner did not
        // spec-decode (e.g. `\xNN`). Its raw form may coincidentally match a DECOY parameter while
        // the
        // real value lives under the decoded name — so do NOT trust any match; force over-redaction
        // so
        // the real value cannot leak (#6097).
        hasUnresolvedKey = true
        continue
      }
      val exact = parameters[key]?.let { parameterStringValue(it) }?.takeIf { it.isNotEmpty() }
      if (exact != null) {
        values.add(exact)
        continue
      }
      val target = normalizeKey(key)
      var matched = false
      for ((paramKey, paramValue) in parameters) {
        if (normalizeKey(paramKey) == target) {
          parameterStringValue(paramValue).takeIf { it.isNotEmpty() }?.let { values.add(it) }
          matched = true
        }
      }
      if (!matched) hasUnresolvedKey = true
    }
    if (hasUnresolvedKey) {
      // A declared secret could not be located even leniently (e.g. a `\xNN` hex-escaped key the
      // scanner did not spec-decode). Over-redact every parameter value so it cannot leak (#6097).
      for (value in parameters.values) {
        parameterStringValue(value).takeIf { it.isNotEmpty() }?.let { values.add(it) }
      }
    }
    return values
  }

  /**
   * Case-folded key with backslashes, quotes, and whitespace/CR removed — the lenient key-identity
   * used to match a mis-encoded declared secret key to a parameter (#6097).
   */
  private fun normalizeKey(key: String): String = buildString {
    for (character in key.lowercase()) {
      when (character) {
        '\\',
        '"',
        '\'',
        ' ',
        '\t',
        '\r',
        '\n' -> Unit
        else -> append(character)
      }
    }
  }

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
      // Peek at the value with a quote-aware comment strip (a `#` inside a quoted key is literal
      // YAML, not a comment): empty -> block sequence, `[` -> flow sequence, else bare scalar.
      // `lines[index]` is the raw line and begins with the key (indent 0).
      val rawValue = lines[index].removePrefix("secretParameters:")
      val inline = stripFlowComment(rawValue).trim()
      if (inline.isNotEmpty()) {
        if (inline.startsWith("[")) {
          // A flow value may span multiple physical lines; a single-pass scanner handles the
          // multiline form, quoted `#`, escaped quotes, trailing comments after `]`, and line
          // folding — and fails safe toward over-capture (#6097).
          val (flowKeys, nextIndex) = parseSecretFlowSequence(lines, index, rawValue)
          keys.addAll(flowKeys)
          index = nextIndex
          continue
        }
        // Bare inline scalar (no brackets): treat as a single key name.
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
   * Scan a `secretParameters:` YAML flow sequence that may span multiple physical lines, returning
   * the declared key names and the index of the next line to resume from. A lenient hand-rolled
   * scanner (a full YAML load chokes on `${...}` in flow collections — issue #6029). It honors
   * quotes; double-quote backslash escaping (`\"`, so a `]`/`,`/`"` after it stays literal); quoted
   * `#` (a `#` inside a scalar is literal — only an unquoted `#` at line start or after whitespace
   * begins a comment); any content after the closing `]` (ignored — including a trailing comment);
   * and YAML newline folding inside a double-quoted scalar (a trailing `\` continues the scalar,
   * dropping the newline; a plain newline folds to a space; continuation indentation is not part of
   * the value).
   *
   * `secretParameters` key names are expected to be literal, simple identifiers. Exotic YAML
   * encodings (`\xNN`/`\uNNNN` hex/unicode escapes, plain-scalar line folding, CRLF-in-quoted
   * multiline keys) are handled best-effort here, NOT with full YAML-spec decoding — so a key may
   * be mis-named. That is made safe at the value layer: [secretParameterValues] matches leniently
   * and, if a declared key still cannot be resolved, over-redacts, so a declared secret's VALUE is
   * always scrubbed (possibly over-redacting), never leaked. Full decoding is tracked as a
   * follow-up to #6097.
   *
   * FAIL-SAFE: key-name parsing errs toward OVER-capturing for redaction, never dropping a declared
   * key (which would leak its value). Every non-empty token is kept as a secret key, and an
   * UNTERMINATED sequence (e.g. from substitution truncation) still yields every token seen
   * (#6097).
   */
  private fun parseSecretFlowSequence(
    lines: List<String>,
    startIndex: Int,
    firstValue: String,
  ): Pair<List<String>, Int> {
    val keys = mutableListOf<String>()
    val current = StringBuilder()
    var itemHasQuotedChar = false
    var depth = 0
    var started = false
    var activeQuote: Char? = null
    var escaped = false
    var lineIndex = startIndex

    // Emit the current item: a plain token is trimmed and a genuinely-empty token (nothing between
    // the
    // delimiters) is dropped, but a quoted scalar whose content is only whitespace (e.g. `" "`) is
    // a
    // valid key and is preserved rather than trimmed away (#6097).
    fun flushItem() {
      val trimmed = current.toString().trim()
      when {
        trimmed.isNotEmpty() -> keys.add(trimmed)
        itemHasQuotedChar -> keys.add(current.toString())
      }
      current.clear()
      itemHasQuotedChar = false
    }

    // Drop a trailing CR so a CRLF-authored quoted multiline key does not embed `\r` (#6097).
    var currentLine = firstValue.removeSuffix("\r")

    while (true) {
      var previous: Char? = null
      var inComment = false
      for (character in currentLine) {
        if (inComment) break
        if (activeQuote != null) {
          if (activeQuote == '"') {
            when {
              escaped -> {
                // `\"` decodes cleanly to `"`; any OTHER escape (`\xNN`, `\uNNNN`, `\n`, …) is NOT
                // spec-decoded here — keep the backslash so the value layer sees this key as
                // low-confidence and over-redacts rather than trusting a coincidental (decoy) match
                // (#6097).
                if (character == '"') current.append('"')
                else current.append('\\').append(character)
                itemHasQuotedChar = true
                escaped = false
              }
              character == '\\' -> escaped = true
              character == '"' -> activeQuote = null
              else -> {
                current.append(character)
                itemHasQuotedChar = true
              }
            }
          } else if (character == '\'') {
            activeQuote = null
          } else {
            current.append(character)
            itemHasQuotedChar = true
          }
        } else if (!started) {
          if (character == '[') {
            started = true
            depth = 1
          }
        } else if (character == '#' && (previous == null || previous == ' ' || previous == '\t')) {
          inComment = true
        } else if (character == '"' || character == '\'') {
          activeQuote = character
        } else if (character == '[') {
          depth++
          current.append(character)
        } else if (character == ']') {
          depth--
          if (depth == 0) {
            flushItem()
            return keys.toList() to (lineIndex + 1)
          }
          current.append(character)
        } else if (character == ',' && depth == 1) {
          flushItem()
        } else {
          current.append(character)
        }
        previous = character
      }

      // Physical line ended. Fold per YAML inside a double-quoted scalar: a trailing `\` continues
      // it
      // (drop the newline); a plain newline folds to a space. Outside a quote, a plain scalar
      // spanning
      // lines is captured token-per-line (over-capture, fail-safe) instead of blending into one
      // key.
      when {
        activeQuote == '"' && escaped -> escaped = false
        activeQuote != null -> current.append(' ')
        started -> flushItem()
      }

      lineIndex++
      if (lineIndex >= lines.size) {
        // Unterminated flow: fail safe — keep every token seen so its value is still redacted.
        flushItem()
        return keys.toList() to lineIndex
      }
      // Drop a trailing CR; inside a quoted scalar the continuation's leading indentation is not
      // part
      // of the value.
      val rawLine = lines[lineIndex].removeSuffix("\r")
      currentLine = if (activeQuote != null) rawLine.trimStart(' ', '\t') else rawLine
    }
  }

  private fun stripComments(line: String): String {
    val hash = line.indexOf('#')
    return if (hash >= 0) line.substring(0, hash) else line
  }

  /**
   * Remove a trailing YAML line comment from a flow line without stripping a `#` that sits inside a
   * quoted scalar. Only an unquoted `#` at line start or preceded by whitespace begins a comment
   * (YAML rule); double-quote backslash escaping is tracked so `\"` does not close the scalar and a
   * following `#` stays literal (#6097).
   */
  private fun stripFlowComment(line: String): String {
    val result = StringBuilder()
    var activeQuote: Char? = null
    var escaped = false
    var previous: Char? = null
    for (character in line) {
      if (activeQuote != null) {
        result.append(character)
        if (activeQuote == '"') {
          when {
            escaped -> escaped = false
            character == '\\' -> escaped = true
            character == '"' -> activeQuote = null
          }
        } else if (character == '\'') {
          activeQuote = null
        }
      } else if (character == '#' && (previous == null || previous == ' ' || previous == '\t')) {
        break
      } else {
        if (character == '"' || character == '\'') activeQuote = character
        result.append(character)
      }
      previous = character
    }
    return result.toString()
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
   * Unquote a flow-list scalar: a single-quoted scalar is literal, a double-quoted scalar has its
   * backslash escapes resolved (so `"a\"]b"` yields `a"]b`), matching the escape tracking used to
   * find the sequence terminator and to split items (#6097).
   */
  private fun unquoteFlowScalar(value: String): String {
    if (value.length >= 2) {
      val first = value.first()
      val last = value.last()
      if (first == '"' && last == '"') {
        return unescapeDoubleQuoted(value.substring(1, value.length - 1))
      }
      if (first == '\'' && last == '\'') {
        return value.substring(1, value.length - 1)
      }
    }
    return value
  }

  /**
   * Resolve backslash escapes inside a double-quoted YAML scalar: `\` escapes the next character
   * literally (so `\"` -> `"`, `\\` -> `\`). Sufficient for key names (#6097).
   */
  private fun unescapeDoubleQuoted(inner: String): String {
    val result = StringBuilder()
    var escaped = false
    for (character in inner) {
      when {
        escaped -> {
          result.append(character)
          escaped = false
        }
        character == '\\' -> escaped = true
        else -> result.append(character)
      }
    }
    if (escaped) result.append('\\')
    return result.toString()
  }

  /**
   * Parse a YAML flow list of scalar keys, e.g. `[apiToken, "password"]`. A comma inside a quoted
   * item is part of the key, not a separator, so `["API,TOKEN"]` yields the single key `API,TOKEN`.
   * Double-quote escaping is honored so `\"` (and any `,`/`]` following it) stays inside the item.
   */
  private fun parseInlineList(value: String): List<String> {
    val inner = value.removePrefix("[").removeSuffix("]")
    val items = mutableListOf<String>()
    val current = StringBuilder()
    var activeQuote: Char? = null
    var escaped = false
    for (character in inner) {
      if (activeQuote != null) {
        current.append(character)
        if (activeQuote == '"') {
          when {
            escaped -> escaped = false
            character == '\\' -> escaped = true
            character == '"' -> activeQuote = null
          }
        } else if (character == '\'') {
          activeQuote = null
        }
      } else {
        when {
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
    }
    items.add(current.toString())
    return items.map { unquoteFlowScalar(it.trim()) }.filter { it.isNotEmpty() }
  }
}
