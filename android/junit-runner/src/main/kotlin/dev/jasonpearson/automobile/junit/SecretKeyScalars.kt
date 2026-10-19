package dev.jasonpearson.automobile.junit

internal object SecretKeyScalars {
  fun stripFlowComment(line: String): String {
    val result = StringBuilder()
    var activeQuote: Char? = null
    var escaped = false
    var previous: Char? = null
    for (character in line) {
      if (activeQuote != null) {
        result.append(character)
        val state = nextQuoteState(activeQuote, escaped, character)
        activeQuote = state.first
        escaped = state.second
      } else if (isCommentStart(character, previous)) {
        break
      } else {
        if (character == '"' || character == '\'') activeQuote = character
        result.append(character)
      }
      previous = character
    }
    return result.toString()
  }

  fun unquote(value: String): String {
    if (value.length >= 2) {
      val first = value.first()
      val last = value.last()
      if (first == last && first in setOf('"', '\'')) {
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
  fun parseInlineList(value: String): List<String> {
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

  private fun nextQuoteState(quote: Char, escaped: Boolean, character: Char): Pair<Char?, Boolean> =
    when {
      quote == '"' && escaped -> quote to false
      quote == '"' && character == '\\' -> quote to true
      character == quote -> null to escaped
      else -> quote to escaped
    }

  fun isCommentStart(character: Char, previous: Char?): Boolean =
    character == '#' && previous in setOf(null, ' ', '\t')
}
