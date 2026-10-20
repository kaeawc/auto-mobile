package dev.jasonpearson.automobile.desktop.core.telemetry

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

internal fun TelemetryEventReader.parseStorage(): TelemetryDisplayEvent {
  if (d["value"]?.let { it !is JsonPrimitive && it !is JsonNull } == true) {
    onFieldMismatch("value")
  }
  return TelemetryDisplayEvent.Storage(
    timestamp = envelope.timestamp,
    fileName = d.stringOrDefault("fileName", d.stringOrDefault("file_name", "unknown")),
    key = d.stringOrNull("key"),
    value = d["value"]?.takeIf { it !is JsonNull }?.displayString(),
    valueType = d.stringOrNull("valueType") ?: d.stringOrNull("value_type"),
    changeType = d.stringOrDefault("changeType", d.stringOrDefault("change_type", "modify")),
    previousValue = d.stringOrNull("previousValue") ?: d.stringOrNull("previous_value"),
  )
}

internal fun TelemetryEventReader.parseLayout(): TelemetryDisplayEvent {
  return TelemetryDisplayEvent.Layout(
    timestamp = envelope.timestamp,
    subType = d.stringOrDefault("subType", d.stringOrDefault("sub_type", "unknown")),
    composableName = d.stringOrNull("composableName") ?: d.stringOrNull("composable_name"),
    recompositionCount =
      d.primitiveOrNull("recompositionCount")?.intOrNull
        ?: d.primitiveOrNull("recomposition_count")?.intOrNull,
    screenName = d.stringOrNull("screenName") ?: d.stringOrNull("screen_name"),
    detailsJson = d.stringOrNull("detailsJson") ?: d.stringOrNull("details_json"),
    durationMs =
      d.primitiveOrNull("durationMs")?.longOrNull ?: d.primitiveOrNull("duration_ms")?.longOrNull,
    likelyCause = d.stringOrNull("likelyCause") ?: d.stringOrNull("likely_cause"),
  )
}

internal fun TelemetryEventReader.parseToolcall(): TelemetryDisplayEvent {
  return TelemetryDisplayEvent.ToolCall(
    timestamp = envelope.timestamp,
    toolName = d.stringOrDefault("toolName", "unknown"),
    durationMs = d.primitiveOrNull("durationMs")?.longOrNull ?: 0,
    success = d.primitiveOrNull("success")?.booleanOrNull ?: true,
    error = d.stringOrNull("error"),
  )
}

internal fun TelemetryEventReader.parseAccessibility(): TelemetryDisplayEvent {
  val violationsList =
    try {
      d["violations"]?.jsonArray?.map { v ->
        val vObj = v.jsonObject
        AccessibilityViolationInfo(
          type = vObj.stringOrDefault("type", "unknown"),
          severity = vObj.stringOrDefault("severity", "warning"),
          criterion = vObj.stringOrDefault("criterion", ""),
          message = vObj.stringOrDefault("message", ""),
        )
      } ?: emptyList()
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
      emptyList()
    }
  return TelemetryDisplayEvent.Accessibility(
    timestamp = envelope.timestamp,
    packageName = d.stringOrDefault("packageName", "unknown"),
    screenId = d.stringOrDefault("screenId", ""),
    totalViolations = d.primitiveOrNull("totalViolations")?.intOrNull ?: 0,
    newViolations = d.primitiveOrNull("newViolations")?.intOrNull ?: 0,
    baselinedCount = d.primitiveOrNull("baselinedCount")?.intOrNull ?: 0,
    violations = violationsList,
  )
}

internal fun TelemetryEventReader.parseMemory(): TelemetryDisplayEvent {
  val violations =
    try {
      d["violations"]?.jsonArray?.map { it.displayString() } ?: emptyList()
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
      emptyList()
    }
  return TelemetryDisplayEvent.Memory(
    timestamp = envelope.timestamp,
    packageName = d.stringOrDefault("packageName", "unknown"),
    passed = d.primitiveOrNull("passed")?.booleanOrNull ?: true,
    javaHeapGrowthMb = d.primitiveOrNull("javaHeapGrowthMb")?.doubleOrNull,
    nativeHeapGrowthMb = d.primitiveOrNull("nativeHeapGrowthMb")?.doubleOrNull,
    gcCount = d.primitiveOrNull("gcCount")?.intOrNull,
    gcDurationMs = d.primitiveOrNull("gcDurationMs")?.longOrNull,
    unreachableObjects = d.primitiveOrNull("unreachableObjects")?.intOrNull,
    violations = violations,
  )
}

internal fun TelemetryEventReader.parsePerformance(): TelemetryDisplayEvent {
  val changed =
    try {
      d["changedMetrics"]?.jsonArray?.map { it.displayString() } ?: emptyList()
    } catch (error: IllegalArgumentException) {
      reportMalformedTelemetry(error)
      emptyList()
    }
  return TelemetryDisplayEvent.Performance(
    timestamp = envelope.timestamp,
    fps = d.primitiveOrNull("fps")?.doubleOrNull,
    frameTimeMs = d.primitiveOrNull("frameTimeMs")?.doubleOrNull,
    jankFrames = d.primitiveOrNull("jankFrames")?.intOrNull,
    touchLatencyMs = d.primitiveOrNull("touchLatencyMs")?.doubleOrNull,
    memoryUsageMb = d.primitiveOrNull("memoryUsageMb")?.doubleOrNull,
    cpuUsagePercent = d.primitiveOrNull("cpuUsagePercent")?.doubleOrNull,
    health = d.stringOrDefault("health", "healthy"),
    changedMetrics = changed,
  )
}

internal fun TelemetryEventReader.parseRuntimeCategory(): TelemetryDisplayEvent? =
  when (envelope.category) {
    "layout" -> parseLayout()
    "toolcall" -> parseToolcall()
    "accessibility" -> parseAccessibility()
    "memory" -> parseMemory()
    "performance" -> parsePerformance()
    else -> null
  }
