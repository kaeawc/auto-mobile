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
        "\"composingEnd\":${event.composingEnd}," +
        "\"result\":${event.result?.toString() ?: "null"}," +
        "\"readValue\":${event.readValue?.let(::quote) ?: "null"}," +
        "\"droppedEvents\":${event.droppedEvents}," +
        "\"metadata\":${metadata(event.metadata)}}"
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

  private fun metadata(value: IcTraceMetadata): String =
    "{" +
      "\"scenario\":${quote(value.scenario)}," +
      "\"keyboardId\":${value.keyboardId?.let(::quote) ?: "null"}," +
      "\"keyboardVersion\":${value.keyboardVersion?.let(::quote) ?: "null"}," +
      "\"editorPackage\":${value.editorPackage?.let(::quote) ?: "null"}," +
      "\"editorFieldId\":${value.editorFieldId}," +
      "\"editorFieldName\":${value.editorFieldName?.let(::quote) ?: "null"}," +
      "\"inputType\":${value.inputType}," +
      "\"imeOptions\":${value.imeOptions}," +
      "\"privateImeOptions\":${value.privateImeOptions?.let(::quote) ?: "null"}}"
}
