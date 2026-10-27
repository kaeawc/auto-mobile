package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.ui.graphics.vector.ImageVector
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons

/** Severity classification for telemetry events, used for filter toggles. */
enum class EventSeverity(val label: String, val icon: ImageVector, val color: Long) {
  Error("Errors", AppIcons.SeverityError, 0xFFFF6B6B),
  Warning("Warnings", AppIcons.SeverityWarning, 0xFFE0C040),
  Info("Info", AppIcons.SeverityInfo, 0xFF74C0FC),
}

/**
 * Classify a telemetry event into a severity level.
 *
 * @param slowNetworkThresholdMs Requests slower than this are classified as Warning (default
 *   3000ms)
 */
fun TelemetryDisplayEvent.classifyEventSeverity(
  slowNetworkThresholdMs: Long = 3000,
): EventSeverity =
  when (this) {
    is TelemetryDisplayEvent.Failure -> classifyFailureSeverity()
    is TelemetryDisplayEvent.Log -> classifyLogSeverity()
    is TelemetryDisplayEvent.Network -> classifyNetworkSeverity(slowNetworkThresholdMs)
    is TelemetryDisplayEvent.Layout -> classifyLayoutSeverity()
    is TelemetryDisplayEvent.Performance -> classifyPerformanceSeverity()
    is TelemetryDisplayEvent.ToolCall -> classifyToolCallSeverity()
    is TelemetryDisplayEvent.Accessibility -> classifyAccessibilitySeverity()
    is TelemetryDisplayEvent.Memory -> classifyMemorySeverity()
    else -> EventSeverity.Info
  }

/** Convenience property using default threshold */
val TelemetryDisplayEvent.eventSeverity: EventSeverity
  get() = classifyEventSeverity()

private fun TelemetryDisplayEvent.Memory.classifyMemorySeverity(): EventSeverity =
  when {
    !passed -> EventSeverity.Error
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Accessibility.classifyAccessibilitySeverity(): EventSeverity =
  when {
    newViolations > 0 -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.ToolCall.classifyToolCallSeverity(): EventSeverity =
  when {
    !success -> EventSeverity.Error
    durationMs > 5000 -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Performance.classifyPerformanceSeverity(): EventSeverity =
  when (health) {
    "critical" -> EventSeverity.Error
    "warning" -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Layout.classifyLayoutSeverity(): EventSeverity =
  when (subType) {
    "excessive_recomposition" -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Network.classifyNetworkSeverity(
  slowNetworkThresholdMs: Long,
): EventSeverity =
  when {
    error != null -> EventSeverity.Error
    statusCode == 0 -> EventSeverity.Error
    statusCode >= 400 -> EventSeverity.Error
    durationMs >= slowNetworkThresholdMs -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Log.classifyLogSeverity(): EventSeverity =
  when (level) {
    6,
    7 -> EventSeverity.Error
    5 -> EventSeverity.Warning
    else -> EventSeverity.Info
  }

private fun TelemetryDisplayEvent.Failure.classifyFailureSeverity(): EventSeverity =
  when (type) {
    "crash",
    "anr" -> EventSeverity.Error
    "nonfatal" -> EventSeverity.Warning
    else -> EventSeverity.Warning
  }
