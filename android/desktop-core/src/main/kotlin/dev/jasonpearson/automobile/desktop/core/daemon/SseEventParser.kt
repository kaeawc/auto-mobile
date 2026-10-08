package dev.jasonpearson.automobile.desktop.core.daemon

/** One dispatched `text/event-stream` event. [data] is the `data:` lines joined with `\n`. */
internal data class SseEvent(val name: String?, val data: String, val id: String?)

/**
 * Parses a fully buffered `text/event-stream` body into its events.
 *
 * The daemon answers each streamable-HTTP POST with one short-lived stream that the MCP SDK
 * transport closes once every response is written, so the body is always complete when it reaches
 * the client. Follows the event-stream rules that matter for a buffered body, mirroring the iOS
 * runner's `SSEEventParser`:
 * - lines end in CRLF, LF or a bare CR;
 * - a line starting with `:` is a comment (the daemon interleaves `:keepalive` lines);
 * - `field: value` drops a single optional space after the colon, and a line with no colon is a
 *   field name with an empty value;
 * - `data` values accumulate and are joined with `\n`, and a blank line dispatches the event;
 * - `event`/`id` fields are per-event, `retry` and unknown fields are ignored;
 * - a trailing event without a terminating blank line is still dispatched.
 *
 * The input is already decoded text: the JDK `HttpClient` decodes the whole body (UTF-8 unless the
 * response names another charset), so a multi-byte character split across network reads cannot be
 * torn by this parser.
 */
internal object SseEventParser {
  fun parse(text: String): List<SseEvent> {
    val events = mutableListOf<SseEvent>()
    var name: String? = null
    var id: String? = null
    val dataLines = mutableListOf<String>()

    fun dispatch() {
      if (dataLines.isNotEmpty()) {
        events += SseEvent(name = name, data = dataLines.joinToString("\n"), id = id)
      }
      name = null
      id = null
      dataLines.clear()
    }

    for (line in splitLines(text.removePrefix(BYTE_ORDER_MARK))) {
      when {
        line.isEmpty() -> dispatch()
        line.startsWith(':') -> Unit
        else -> {
          val colon = line.indexOf(':')
          val field = if (colon < 0) line else line.substring(0, colon)
          val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
          when (field) {
            "event" -> name = value
            "data" -> dataLines += value
            "id" -> id = value
          }
        }
      }
    }
    dispatch()
    return events
  }

  /** Splits on CRLF, LF and bare CR, keeping empty lines because a blank line ends an event. */
  private fun splitLines(text: String): List<String> {
    val lines = mutableListOf<String>()
    var start = 0
    var index = 0
    while (index < text.length) {
      val c = text[index]
      if (c == '\n' || c == '\r') {
        lines += text.substring(start, index)
        if (c == '\r' && index + 1 < text.length && text[index + 1] == '\n') {
          index++
        }
        start = index + 1
      }
      index++
    }
    if (start < text.length) {
      lines += text.substring(start)
    }
    return lines
  }

  private const val BYTE_ORDER_MARK = "﻿"
}
