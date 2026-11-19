package dev.jasonpearson.automobile.protocol

/**
 * Keeps an inserted value literal through every later placeholder scan (#18628). A data, row,
 * derived or state value is inserted into authored text before later passes read that text for
 * `{key}`, `{derived:name}`, `{data:/pointer}` and row placeholders. [shield] puts U+2060 WORD
 * JOINER right after each `{` in the value that opens a key, so no scanner matches it, and the
 * final text interpolation calls [unshield] to remove it. The joiner is zero-width, so a field no
 * final pass reads still draws the same glyphs.
 *
 * A `{` already followed by joiners before a key gets one more, and [unshield] removes exactly one,
 * so every inserted value round-trips exactly.
 */
object PrototypeTextShield {
  const val MARK = '⁠'

  fun shield(value: String): String {
    if (value.indexOf('{') < 0) return value
    val out = StringBuilder(value.length + 2)
    for (index in value.indices) {
      out.append(value[index])
      if (value[index] == '{' && opensAfterMarks(value, index + 1)) out.append(MARK)
    }
    return out.toString()
  }

  fun unshield(text: String): String {
    if (text.indexOf(MARK) < 0) return text
    val out = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
      out.append(text[index])
      index +=
        if (
          text[index] == '{' &&
            index + 1 < text.length &&
            text[index + 1] == MARK &&
            opensAfterMarks(text, index + 1)
        )
          2
        else 1
    }
    return out.toString()
  }

  /** Whether the joiners from [start] are followed by a key's first character. */
  private fun opensAfterMarks(text: String, start: Int): Boolean {
    var index = start
    while (index < text.length && text[index] == MARK) index++
    if (index >= text.length) return false
    val c = text[index]
    return c in 'A'..'Z' || c in 'a'..'z' || c == '_'
  }
}
