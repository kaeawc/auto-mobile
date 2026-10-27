package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeLog(
  event: TelemetryDisplayEvent.Log,
) {

  put("type", JsonPrimitive("log"))
  put("level", JsonPrimitive(event.level))
  put("tag", JsonPrimitive(event.tag))
  put("message", JsonPrimitive(event.message))
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeNavigation(
  event: TelemetryDisplayEvent.Navigation,
) {

  put("type", JsonPrimitive("navigation"))
  put("destination", JsonPrimitive(event.destination))
  event.source?.let { put("source", JsonPrimitive(it)) }
  event.triggeringInteraction?.let { put("triggeringInteraction", JsonPrimitive(it)) }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeOs(
  event: TelemetryDisplayEvent.Os,
) {

  put("type", JsonPrimitive("os"))
  put("category", JsonPrimitive(event.category))
  put("kind", JsonPrimitive(event.kind))
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeStorage(
  event: TelemetryDisplayEvent.Storage,
) {

  put("type", JsonPrimitive("storage"))
  put("fileName", JsonPrimitive(event.fileName))
  event.key?.let { put("key", JsonPrimitive(it)) }
  event.value?.let { put("value", JsonPrimitive(it)) }
  put("changeType", JsonPrimitive(event.changeType))
  event.previousValue?.let { put("previousValue", JsonPrimitive(it)) }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeLayout(
  event: TelemetryDisplayEvent.Layout,
) {

  put("type", JsonPrimitive("layout"))
  put("subType", JsonPrimitive(event.subType))
  event.composableName?.let { put("composableName", JsonPrimitive(it)) }
  event.screenName?.let { put("screenName", JsonPrimitive(it)) }
  event.durationMs?.let { put("durationMs", JsonPrimitive(it)) }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializePerformance(
  event: TelemetryDisplayEvent.Performance,
) {

  put("type", JsonPrimitive("performance"))
  put("health", JsonPrimitive(event.health))
  event.fps?.let { put("fps", JsonPrimitive(it)) }
  event.frameTimeMs?.let { put("frameTimeMs", JsonPrimitive(it)) }
  event.cpuUsagePercent?.let { put("cpuUsagePercent", JsonPrimitive(it)) }
  event.memoryUsageMb?.let { put("memoryUsageMb", JsonPrimitive(it)) }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeMemory(
  event: TelemetryDisplayEvent.Memory,
) {

  put("type", JsonPrimitive("memory"))
  put("packageName", JsonPrimitive(event.packageName))
  put("passed", JsonPrimitive(event.passed))
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeToolCall(
  event: TelemetryDisplayEvent.ToolCall,
) {

  put("type", JsonPrimitive("toolcall"))
  put("toolName", JsonPrimitive(event.toolName))
  put("durationMs", JsonPrimitive(event.durationMs))
  put("success", JsonPrimitive(event.success))
  event.error?.let { put("error", JsonPrimitive(it)) }
}

internal fun kotlinx.serialization.json.JsonObjectBuilder.serializeAccessibility(
  event: TelemetryDisplayEvent.Accessibility,
) {

  put("type", JsonPrimitive("accessibility"))
  put("packageName", JsonPrimitive(event.packageName))
  put("screenId", JsonPrimitive(event.screenId))
  put("totalViolations", JsonPrimitive(event.totalViolations))
  put("newViolations", JsonPrimitive(event.newViolations))
  put("baselinedCount", JsonPrimitive(event.baselinedCount))
  if (event.violations.isNotEmpty()) {
    put(
      "violations",
      buildJsonArray {
        event.violations.forEach { v ->
          add(
            buildJsonObject {
              put("type", JsonPrimitive(v.type))
              put("severity", JsonPrimitive(v.severity))
              put("criterion", JsonPrimitive(v.criterion))
              put("message", JsonPrimitive(v.message))
            },
          )
        }
      },
    )
  }
}
