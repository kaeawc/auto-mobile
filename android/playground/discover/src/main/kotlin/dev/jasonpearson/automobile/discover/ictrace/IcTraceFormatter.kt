package dev.jasonpearson.automobile.discover.ictrace

object IcTraceFormatter {
  fun format(events: List<IcTraceEvent>): String =
    events.joinToString("\n") { event ->
      "{" +
        "\"seq\":${event.seq}," +
        "\"elapsedMs\":${event.elapsedMs}," +
        "\"call\":${quote(event.call)}," +
        "\"args\":${quote(event.args)}," +
        "\"selectionStart\":${event.selectionStart}," +
        "\"selectionEnd\":${event.selectionEnd}," +
        "\"composingStart\":${event.composingStart}," +
        "\"composingEnd\":${event.composingEnd}}"
    }

  fun summary(events: List<IcTraceEvent>): String =
    events
      .groupingBy { it.call }
      .eachCount()
      .entries
      .joinToString("\n") { (call, count) ->
        "$call: $count"
      }

  private fun quote(value: String): String = buildString {
    append('"')
    for (char in value) {
      when (char) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\b' -> append("\\b")
        '\u000c' -> append("\\f")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else ->
          if (char.code < 0x20) append(String.format(java.util.Locale.ROOT, "\\u%04x", char.code))
          else append(char)
      }
    }
    append('"')
  }
}
