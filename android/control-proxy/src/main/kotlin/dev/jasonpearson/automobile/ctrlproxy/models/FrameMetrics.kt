package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.Serializable

/**
 * Frame-metrics rollup broadcast by the in-app `auto-mobile-sdk` `FrameMetricsCollector`
 * (issue #5076). Deserialized from the Intent payload; `fps`/`frameTimeMs`/`jankFrames` are absent
 * for a window with no rendered frames.
 */
@Serializable
data class FrameMetricsSnapshot(
  val timestamp: Long,
  val applicationId: String? = null,
  val fps: Double? = null,
  val frameTimeMs: Double? = null,
  val jankFrames: Int? = null,
  val totalFrames: Int = 0,
)
