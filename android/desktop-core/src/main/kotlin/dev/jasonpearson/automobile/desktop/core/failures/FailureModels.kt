package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.ui.graphics.Color

typealias FailureType = dev.jasonpearson.automobile.desktop.domain.FailureType

typealias FailureSeverity = dev.jasonpearson.automobile.desktop.domain.FailureSeverity

typealias StackTraceElement = dev.jasonpearson.automobile.desktop.domain.StackTraceElement

typealias DeviceBreakdown = dev.jasonpearson.automobile.desktop.domain.DeviceBreakdown

typealias VersionBreakdown = dev.jasonpearson.automobile.desktop.domain.VersionBreakdown

typealias ScreenBreakdown = dev.jasonpearson.automobile.desktop.domain.ScreenBreakdown

typealias DurationStats = dev.jasonpearson.automobile.desktop.domain.DurationStats

typealias AggregatedToolCallInfo = dev.jasonpearson.automobile.desktop.domain.AggregatedToolCallInfo

typealias FailureCapture = dev.jasonpearson.automobile.desktop.domain.FailureCapture

typealias CaptureType = dev.jasonpearson.automobile.desktop.domain.CaptureType

typealias FailureOccurrence = dev.jasonpearson.automobile.desktop.domain.FailureOccurrence

typealias FailureGroup = dev.jasonpearson.automobile.desktop.domain.FailureGroup

/** Compose Color for each failure type (UI-layer concern, not in domain). */
val FailureType.color: Color
  get() =
      when (this) {
        FailureType.Crash -> Color(0xFFE53935)
        FailureType.ANR -> Color(0xFFFF9800)
        FailureType.ToolCallFailure -> Color(0xFF9C27B0)
        FailureType.NonFatal -> Color(0xFF2196F3)
      }

/** Compose Color for each failure severity (UI-layer concern, not in domain). */
val FailureSeverity.color: Color
  get() =
      when (this) {
        FailureSeverity.Critical -> Color(0xFFE53935)
        FailureSeverity.High -> Color(0xFFFF5722)
        FailureSeverity.Medium -> Color(0xFFFF9800)
        FailureSeverity.Low -> Color(0xFFFFC107)
      }
