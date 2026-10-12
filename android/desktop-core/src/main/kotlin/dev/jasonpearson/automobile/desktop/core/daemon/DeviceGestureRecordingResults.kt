package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable

@Serializable
data class DeviceGestureRecordingStartResult(
  val recordingId: String,
  val startedAt: String,
  val deviceId: String? = null,
  val platform: String? = null,
)

@Serializable
data class DeviceGestureRecordingStopResult(
  val recordingId: String,
  val startedAt: String,
  val stoppedAt: String,
  val durationMs: Long,
  val planName: String,
  val planContent: String,
  val stepCount: Int,
  val deviceId: String? = null,
  val platform: String? = null,
)
