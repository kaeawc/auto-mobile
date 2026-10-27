package dev.jasonpearson.automobile.junit

/** Stateful, best-effort flow scanning only for plans that fail the primary SnakeYAML load. */
internal class SecretFlowScanner {
  private val keys = mutableListOf<String>()
  private val current = StringBuilder()
  private var itemHasQuotedChar = false
  private var depth = 0
  private var started = false
  private var activeQuote: Char? = null
  private var escaped = false

  fun parse(lines: List<String>, startIndex: Int, firstValue: String): Pair<List<String>, Int> {
    var lineIndex = startIndex
    var line = firstValue.removeSuffix("\r")
    while (true) {
      if (consumeLine(line)) return keys.toList() to (lineIndex + 1)
      finishLine()
      lineIndex++
      if (lineIndex >= lines.size) {
        // Unterminated flows still contribute every token: fail safe toward over-redaction.
        flushItem()
        return keys.toList() to lineIndex
      }
      val raw = lines[lineIndex].removeSuffix("\r")
      line = if (activeQuote != null) raw.trimStart(' ', '\t') else raw
    }
  }

  private fun consumeLine(line: String): Boolean {
    var previous: Char? = null
    for (character in line) {
      if (activeQuote != null) consumeQuoted(character)
      else if (!started) {
        if (character == '[') {
          started = true
          depth = 1
        }
      } else {
        if (SecretKeyScalars.isCommentStart(character, previous)) break
        if (consumeUnquoted(character)) return true
      }
      previous = character
    }
    return false
  }

  private fun consumeUnquoted(character: Char): Boolean {
    when (character) {
      '"',
      '\'' -> activeQuote = character
      '[' -> {
        depth++
        current.append(character)
      }
      ']' -> {
        depth--
        if (depth == 0) {
          flushItem()
          return true
        }
        current.append(character)
      }
      ',' -> if (depth == 1) flushItem() else current.append(character)
      else -> current.append(character)
    }
    return false
  }

  private fun consumeQuoted(character: Char) {
    if (activeQuote == '"') consumeDoubleQuoted(character)
    else if (character == '\'') activeQuote = null else appendQuoted(character)
  }

  private fun consumeDoubleQuoted(character: Char) {
    when {
      escaped -> {
        // Decode escaped quotes only; retain other escapes so value matching over-redacts.
        if (character == '"') current.append('"') else current.append('\\').append(character)
        itemHasQuotedChar = true
        escaped = false
      }
      character == '\\' -> escaped = true
      character == '"' -> activeQuote = null
      else -> appendQuoted(character)
    }
  }

  private fun appendQuoted(character: Char) {
    current.append(character)
    itemHasQuotedChar = true
  }

  private fun finishLine() {
    when {
      activeQuote == '"' && escaped -> escaped = false
      activeQuote != null -> current.append(' ')
      started -> flushItem()
    }
  }

  private fun flushItem() {
    val trimmed = current.toString().trim()
    when {
      trimmed.isNotEmpty() -> keys.add(trimmed)
      itemHasQuotedChar -> keys.add(current.toString())
    }
    current.clear()
    itemHasQuotedChar = false
  }
}
