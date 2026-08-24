package dev.jasonpearson.automobile.desktop.core.telemetry

import dev.jasonpearson.automobile.desktop.core.clipboard.ClipboardWriter

/**
 * Pure, deterministic formatters that export an inspector [TelemetryDisplayEvent] to shareable text
 * (cURL, Markdown). No clipboard access lives here so the formatting logic is unit-testable in
 * isolation (#5205). The `ClipboardWriter.copy*` extensions below compose a formatter with a write,
 * so a copy action can also be exercised through an injected [ClipboardWriter] fake.
 */

/** Header names whose values are redacted in any exported representation. */
private val REDACTED_HEADERS = setOf("authorization", "cookie", "set-cookie")

private fun redactHeaderValue(name: String, value: String): String =
  if (name.lowercase() in REDACTED_HEADERS) "[REDACTED]" else value

/** Escape a value for embedding inside a single-quoted shell string. */
private fun shellSingleQuoteEscape(value: String): String = value.replace("'", "'\\''")

/**
 * Render [event] as a runnable `curl` command that reproduces the captured request: method, request
 * headers (secrets redacted), request body, and URL. Deterministic given the event.
 */
internal fun networkAsCurl(event: TelemetryDisplayEvent.Network): String {
  val sb = StringBuilder()
  sb.append("curl -X ${event.method}")
  event.requestHeaders?.forEach { (key, value) ->
    val displayValue = redactHeaderValue(key, value)
    sb.append(" \\\n  -H '${key}: ${shellSingleQuoteEscape(displayValue)}'")
  }
  val reqBody = event.requestBody
  if (!reqBody.isNullOrBlank()) {
    sb.append(" \\\n  -d '${shellSingleQuoteEscape(reqBody)}'")
  }
  sb.append(" \\\n  '${event.url}'")
  return sb.toString()
}

/**
 * Render [event] as a paste-ready Markdown table with a deterministic field order. Pipe characters
 * in values are escaped so the table stays well-formed.
 */
internal fun eventAsMarkdown(event: TelemetryDisplayEvent): String {
  val rows = mutableListOf<Pair<String, String>>()
  rows.add("Type" to event.javaClass.simpleName)
  rows.add("Time" to event.timestamp.toString())

  when (event) {
    is TelemetryDisplayEvent.Network -> {
      rows.add("URL" to event.url)
      rows.add("Method" to event.method)
      rows.add("Status" to "${event.statusCode}")
      rows.add("Duration" to "${event.durationMs}ms")
    }
    is TelemetryDisplayEvent.Log -> {
      rows.add("Tag" to event.tag)
      rows.add("Message" to event.message)
    }
    is TelemetryDisplayEvent.Navigation -> {
      rows.add("Destination" to event.destination)
      event.source?.let { rows.add("Source" to it) }
    }
    is TelemetryDisplayEvent.Failure -> {
      rows.add("Title" to event.title)
      rows.add("Severity" to event.severity)
    }
    is TelemetryDisplayEvent.Performance -> {
      event.fps?.let { rows.add("FPS" to "${it.toInt()}") }
      event.cpuUsagePercent?.let { rows.add("CPU" to "${"%.1f".format(it)}%") }
      event.memoryUsageMb?.let { rows.add("Memory" to "${it.toInt()} MB") }
    }
    else -> {}
  }

  val sb = StringBuilder()
  sb.appendLine("| Field | Value |")
  sb.appendLine("|-------|-------|")
  rows.forEach { (k, v) -> sb.appendLine("| $k | ${v.replace("|", "\\|")} |") }
  return sb.toString()
}

/** Copy [event] to [this] clipboard as a runnable cURL command. */
internal fun ClipboardWriter.copyNetworkAsCurl(event: TelemetryDisplayEvent.Network) {
  writeText(networkAsCurl(event))
}

/** Copy [event] to [this] clipboard as a Markdown table. */
internal fun ClipboardWriter.copyEventAsMarkdown(event: TelemetryDisplayEvent) {
  writeText(eventAsMarkdown(event))
}
