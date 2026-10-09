package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The video recording the desktop started: which device, the recording id the daemon returned and
 * the daemon session that owns it (#10978). Stopping or fetching the artifact goes by [recordingId]
 * alone, which needs no device; [ownerSessionUuid] scopes the daemon's artifact lookup to the
 * session that started it, because the desktop rotates to a fresh session on release.
 */
data class TrackedRecording(
  val deviceId: String,
  val recordingId: String,
  val ownerSessionUuid: String?,
)

/**
 * Hoisted recording state shared by the device-controls dashboard and the session composition: the
 * composition must not release a device that is being recorded just because the window is hidden
 * (#10978), and the dashboard keys its Record/Stop button on this, not on a local flag.
 */
class ActiveRecordingTracker {
  var current: TrackedRecording? by mutableStateOf(null)
    private set

  fun begin(recording: TrackedRecording) {
    current = recording
  }

  fun clear() {
    current = null
  }

  fun isRecordingOn(deviceId: String): Boolean = current?.deviceId == deviceId
}
