package dev.jasonpearson.automobile.desktop.core.telemetry

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Exports telemetry events in various formats: JSON, CSV, and HAR (for network events).
 */
object TelemetryExporter {

    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US)

    /**
     * Exports events as a pretty-printed JSON array.
     */
    fun exportAsJson(events: List<TelemetryDisplayEvent>): String {
        val sb = StringBuilder()
        sb.appendLine("[")
        events.forEachIndexed { index, event ->
            sb.append("  ")
            sb.append(eventToJson(event))
            if (index < events.size - 1) sb.append(",")
            sb.appendLine()
        }
        sb.append("]")
        return sb.toString()
    }

    /**
     * Exports events as CSV with columns: timestamp, type, summary.
     */
    fun exportAsCsv(events: List<TelemetryDisplayEvent>): String {
        val sb = StringBuilder()
        sb.appendLine("timestamp,type,summary")
        events.forEach { event ->
            val ts = isoFormat.format(Date(event.timestamp))
            val type = eventTypeName(event)
            val summary = eventSummary(event)
            sb.appendLine("${csvEscape(ts)},${csvEscape(type)},${csvEscape(summary)}")
        }
        return sb.toString()
    }

    /**
     * Exports network events in HAR 1.2 format, suitable for importing into browser dev tools.
     */
    fun exportAsHar(events: List<TelemetryDisplayEvent.Network>): String {
        val sb = StringBuilder()
        sb.appendLine("""{
  "log": {
    "version": "1.2",
    "creator": { "name": "AutoMobile", "version": "1.0" },
    "entries": [""")
        events.forEachIndexed { index, event ->
            val startTime = isoFormat.format(Date(event.timestamp))
            val reqHeaders = event.requestHeaders?.entries?.joinToString(",\n            ") {
                """{ "name": ${jsonString(it.key)}, "value": ${jsonString(it.value)} }"""
            } ?: ""
            val respHeaders = event.responseHeaders?.entries?.joinToString(",\n            ") {
                """{ "name": ${jsonString(it.key)}, "value": ${jsonString(it.value)} }"""
            } ?: ""
            val reqBodyText = event.requestBody?.let {
                """,
          "postData": { "mimeType": ${jsonString(event.contentType ?: "application/octet-stream")}, "text": ${jsonString(it)} }"""
            } ?: ""
            val respBodyText = event.responseBody?.let {
                """,
            "content": { "size": ${it.length}, "mimeType": ${jsonString(event.contentType ?: "application/octet-stream")}, "text": ${jsonString(it)} }"""
            } ?: """,
            "content": { "size": 0, "mimeType": "" }"""

            sb.append("""      {
        "startedDateTime": ${jsonString(startTime)},
        "time": ${event.durationMs},
        "request": {
          "method": ${jsonString(event.method)},
          "url": ${jsonString(event.url)},
          "httpVersion": "HTTP/1.1",
          "headers": [ $reqHeaders ],
          "queryString": [],
          "bodySize": ${event.requestBody?.length ?: -1}$reqBodyText
        },
        "response": {
          "status": ${event.statusCode},
          "statusText": "",
          "httpVersion": "HTTP/1.1",
          "headers": [ $respHeaders ],
          "redirectURL": ""$respBodyText
        },
        "cache": {},
        "timings": { "send": 0, "wait": ${event.durationMs}, "receive": 0 }
      }""")
            if (index < events.size - 1) sb.append(",")
            sb.appendLine()
        }
        sb.appendLine("""    ]
  }
}""")
        return sb.toString()
    }

    private fun eventTypeName(event: TelemetryDisplayEvent): String = when (event) {
        is TelemetryDisplayEvent.Network -> "network"
        is TelemetryDisplayEvent.Log -> "log"
        is TelemetryDisplayEvent.Custom -> "custom"
        is TelemetryDisplayEvent.Os -> "os"
        is TelemetryDisplayEvent.Navigation -> "navigation"
        is TelemetryDisplayEvent.Failure -> event.type
        is TelemetryDisplayEvent.Storage -> "storage"
        is TelemetryDisplayEvent.ToolCall -> "toolcall"
        is TelemetryDisplayEvent.Accessibility -> "accessibility"
        is TelemetryDisplayEvent.Memory -> "memory"
        is TelemetryDisplayEvent.Performance -> "performance"
        is TelemetryDisplayEvent.Layout -> "layout"
    }

    private fun eventSummary(event: TelemetryDisplayEvent): String = when (event) {
        is TelemetryDisplayEvent.Network -> "${event.method} ${event.statusCode} ${event.url} (${event.durationMs}ms)"
        is TelemetryDisplayEvent.Log -> "[${event.tag}] ${event.message}"
        is TelemetryDisplayEvent.Custom -> event.name
        is TelemetryDisplayEvent.Os -> "[${event.category}] ${event.kind}"
        is TelemetryDisplayEvent.Navigation -> event.destination
        is TelemetryDisplayEvent.Failure -> "[${event.type.uppercase()}] ${event.title}"
        is TelemetryDisplayEvent.Storage -> "[${event.changeType}] ${event.fileName}"
        is TelemetryDisplayEvent.ToolCall -> "${event.toolName} ${if (event.success) "${event.durationMs}ms" else "FAILED"}"
        is TelemetryDisplayEvent.Accessibility -> "${event.newViolations} violations (${event.packageName})"
        is TelemetryDisplayEvent.Memory -> "[${if (event.passed) "PASS" else "FAIL"}] ${event.packageName}"
        is TelemetryDisplayEvent.Performance -> "[${event.health}]"
        is TelemetryDisplayEvent.Layout -> "${event.subType} ${event.composableName ?: ""}"
    }

    private fun eventToJson(event: TelemetryDisplayEvent): String {
        val ts = isoFormat.format(Date(event.timestamp))
        val type = eventTypeName(event)
        val summary = eventSummary(event)
        return """{ "timestamp": ${jsonString(ts)}, "type": ${jsonString(type)}, "summary": ${jsonString(summary)} }"""
    }

    private fun csvEscape(value: String): String {
        return if (value.contains(",") || value.contains("\"") || value.contains("\n")) {
            "\"${value.replace("\"", "\"\"")}\""
        } else {
            value
        }
    }

    private fun jsonString(value: String): String {
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }
}
