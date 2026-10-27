package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.GestureDescription

internal data class GestureDispatchRequest(
  val perfLabel: String,
  val gesture: GestureDescription,
  val requestId: String?,
  val startTimeMs: Long,
  val gestureBuiltTimeMs: Long,
  val frameContext: String? = null,
)

internal data class MultiFingerStrokeGeometry(
  val x1: Double,
  val y1: Double,
  val x2: Double,
  val y2: Double,
  val offset: Int,
  val fingerCount: Int,
)

internal data class PinchStrokeGeometry(
  val centerX: Double,
  val centerY: Double,
  val distanceStart: Double,
  val distanceEnd: Double,
  val rotationDegrees: Float,
)

internal data class OwnWindowEvent(
  val eventPackage: String?,
  val ownPackage: String,
  val windowId: Int,
)

internal data class PrecedingInputExpectation(
  val expectedSuffix: String,
  val deadlineMs: Long = 300L,
  val pollMs: Long = 25L,
  val baseline: InsertTextSnapshot? = null,
  val matches: (InsertTextSnapshot) -> Boolean = {
    isPrecedingInputReflected(it, expectedSuffix, baseline)
  },
)

data class NavigationEventInput(
  val destination: String,
  val source: String,
  val arguments: Map<String, String>,
  val metadata: Map<String, String>,
  val applicationId: String? = null,
  val timestamp: Long = System.currentTimeMillis(),
)
