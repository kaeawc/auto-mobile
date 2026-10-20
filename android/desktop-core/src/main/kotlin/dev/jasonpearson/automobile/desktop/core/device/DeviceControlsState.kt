package dev.jasonpearson.automobile.desktop.core.device

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.ActiveRecordingTracker
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceConfig
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceSyncMode
import dev.jasonpearson.automobile.desktop.core.daemon.TrackedRecording
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingArtifact
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfig
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamDescriptor
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun rememberDeviceControlsMemory(): DeviceControlsMemory {
  val appearanceState = remember { mutableStateOf<AppearanceConfig?>(null) }
  val appliedModeState = remember { mutableStateOf<AppearanceSyncMode?>(null) }
  val recordingConfigState = remember { mutableStateOf<VideoRecordingConfig?>(null) }
  val artifactsState = remember { mutableStateOf<List<VideoRecordingArtifact>>(emptyList()) }
  val manifestPathState = remember { mutableStateOf<String?>(null) }
  val busyState = remember { mutableStateOf(false) }
  val noticeState = remember { mutableStateOf<String?>(null) }
  val errorState = remember { mutableStateOf<String?>(null) }
  val streamsState = remember { mutableStateOf<List<WebRtcStreamDescriptor>>(emptyList()) }
  return DeviceControlsMemory(
    appearanceState,
    appliedModeState,
    recordingConfigState,
    artifactsState,
    manifestPathState,
    busyState,
    noticeState,
    errorState,
    streamsState,
  )
}

@Composable
internal fun DeviceControlsClients.LoadStreams(memory: DeviceControlsMemory) {
  with(memory) {
    LaunchedEffect(streamClient) {
      if (streamClient?.isAvailable() != true) return@LaunchedEffect
      streams =
        try {
          withContext(ioDispatcher) { streamClient.listStreams() }
        } catch (e: java.io.IOException) {
          LOG.warn("Could not list WebRTC streams: ${e.message}", e)
          emptyList()
        } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
          LOG.warn("Could not list WebRTC streams: ${e.message}", e)
          emptyList()
        } catch (e: IllegalArgumentException) {
          LOG.warn("Could not list WebRTC streams: ${e.message}", e)
          emptyList()
        }
    }
  }
}

@Composable
internal fun DeviceControlsClients.LoadDeviceConfiguration(memory: DeviceControlsMemory) {
  with(memory) {
    LaunchedEffect(appearanceClient, recordingConfigClient) {
      withContext(ioDispatcher) {
        appearance =
          try {
            if (appearanceClient?.isAvailable() == true) appearanceClient.getConfig().config
            else null
          } catch (e: java.io.IOException) {
            LOG.warn("Appearance config unavailable: ${e.message}", e)
            null
          } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
            LOG.warn("Appearance config unavailable: ${e.message}", e)
            null
          } catch (e: IllegalArgumentException) {
            LOG.warn("Appearance config unavailable: ${e.message}", e)
            null
          }
        recordingConfig =
          try {
            if (recordingConfigClient?.isAvailable() == true) {
              recordingConfigClient.getConfig().config
            } else {
              null
            }
          } catch (e: java.io.IOException) {
            LOG.warn("Recording config unavailable: ${e.message}", e)
            null
          } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
            LOG.warn("Recording config unavailable: ${e.message}", e)
            null
          } catch (e: IllegalArgumentException) {
            LOG.warn("Recording config unavailable: ${e.message}", e)
            null
          }
      }
    }
  }
}

internal fun DeviceControlsClients.runDeviceAction(
  memory: DeviceControlsMemory,
  scope: kotlinx.coroutines.CoroutineScope,
  label: String,
  block: suspend () -> String?,
) {
  with(memory) {
    busy = true
    notice = null
    error = null
    scope.launch {
      try {
        notice = withContext(ioDispatcher) { block() }
      } catch (cancellation: kotlinx.coroutines.CancellationException) {
        throw cancellation
      } catch (e: IllegalStateException) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } catch (e: java.io.IOException) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } catch (e: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } catch (e: IllegalArgumentException) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } finally {
        busy = false
      }
    }
  }
}

internal fun DeviceControlsClients.finishDeviceRecording(
  memory: DeviceControlsMemory,
  activeRecordings: ActiveRecordingTracker,
  tracked: TrackedRecording,
  outcome: String,
): String {
  with(memory) {
    try {
      val result =
        recordingActions?.stopRecording(
          tracked.deviceId,
          tracked.recordingId,
          tracked.ownerSessionUuid,
        )
      artifacts = result?.recordings.orEmpty()
      manifestPath = result?.manifestPath
      val count = artifacts.size
      return if (result?.segmented == true) {
        "$outcome — $count segment(s) across ${result.sessions.size} session(s)"
      } else {
        "$outcome — $count recording(s)"
      }
    } finally {
      activeRecordings.clear()
    }
  }
}

private val LOG = LoggerFactory.getLogger("DeviceControlsDashboard")
