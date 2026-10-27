package dev.jasonpearson.automobile.desktop.core.daemon

internal fun parseStdioCommand(command: String): List<String> =
  StdioCommandTokenizer().parse(command)

private class StdioCommandTokenizer {
  private val parts = mutableListOf<String>()
  private val current = StringBuilder()
  private var inSingle = false
  private var inDouble = false
  private var escapeNext = false

  fun parse(command: String): List<String> {
    command.forEach(::consume)
    flushCurrent()
    return parts
  }

  private fun consume(char: Char) {
    if (escapeNext) {
      current.append(char)
      escapeNext = false
      return
    }
    when (char) {
      '\\' -> if (inDouble) escapeNext = true else current.append(char)
      '\'' -> singleQuote(char)
      '"' -> doubleQuote(char)
      ' ',
      '\t',
      '\n' -> if (inSingle || inDouble) current.append(char) else flushCurrent()
      else -> current.append(char)
    }
  }

  private fun singleQuote(char: Char) {
    if (!inDouble) inSingle = !inSingle else current.append(char)
  }

  private fun doubleQuote(char: Char) {
    if (!inSingle) inDouble = !inDouble else current.append(char)
  }

  private fun flushCurrent() {
    if (current.isNotEmpty()) {
      parts.add(current.toString())
      current.clear()
    }
  }
}
