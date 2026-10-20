package dev.jasonpearson.automobile.desktop.core

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import dev.jasonpearson.automobile.desktop.core.video.LiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.core.video.autoReconnects
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.isActive

@Composable
internal fun LiveVideoLifetime(
  options: LiveVideoFrameOptions,
  frame: MutableState<LiveVideoFrame?>,
) {
  with(options) {
    DisposableEffect(source, deviceId) {
      onDispose {
        frame.value = null
        source?.dispose()
      }
    }
    DisposableEffect(source, deviceId, streamingEnabled) {
      if (source != null && deviceId != null) {
        if (streamingEnabled) source.connect(deviceId) else source.disconnect()
      }
      onDispose {}
    }
    LaunchedEffect(source) {
      source?.frames?.conflate()?.collect { next ->
        if (source.state.value is VideoStreamState.Streaming) frame.value = next
      }
    }
  }
}

@Composable
internal fun LiveVideoRetryEffect(
  options: LiveVideoFrameOptions,
  frame: MutableState<LiveVideoFrame?>,
) {
  with(options) {
    LaunchedEffect(source, deviceId, autoReconnect, streamingEnabled) {
      if (source == null || !streamingEnabled) return@LaunchedEffect
      LiveVideoRetry(options, source, frame).collect()
    }
  }
}

private class LiveVideoRetry(
  private val options: LiveVideoFrameOptions,
  private val source: VideoStreamSource,
  private val frame: MutableState<LiveVideoFrame?>,
) {
  private var backoffMs = options.reconnectInitialMs
  private var lastSeenEmittedSequence = source.emittedFrameSequence.value

  private fun resetBackoffAfterFrame() {
    val sequence = source.emittedFrameSequence.value
    if (sequence > lastSeenEmittedSequence) {
      lastSeenEmittedSequence = sequence
      backoffMs = options.reconnectInitialMs
    }
  }

  suspend fun collect() {
    source.state.collectLatest { state ->
      resetBackoffAfterFrame()
      if (state is VideoStreamState.Streaming) backoffMs = options.reconnectInitialMs
      val needsRecovery =
        state is VideoStreamState.Unavailable ||
          state is VideoStreamState.PermissionRequired ||
          state is VideoStreamState.Ended
      if (needsRecovery) {
        if (!options.autoReconnect) frame.value = null
        val deviceId = options.deviceId
        if (options.autoReconnect && deviceId != null && state.autoReconnects()) retry(deviceId)
      }
    }
  }

  private suspend fun retry(deviceId: String) {
    // collectLatest cancels this loop only on a genuine state transition or disposal.
    while (currentCoroutineContext().isActive) {
      resetBackoffAfterFrame()
      options.delayMs(backoffMs)
      backoffMs = (backoffMs * 2).coerceAtMost(LIVE_RECONNECT_MAX_MS)
      source.connect(deviceId)
    }
  }
}

@Composable
internal fun LiveVideoWatchdogEffect(
  options: LiveVideoFrameOptions,
  frame: MutableState<LiveVideoFrame?>,
) {
  with(options) {
    LaunchedEffect(source, deviceId, autoReconnect, streamingEnabled, stallReconnectMs) {
      val canWatch = autoReconnect && streamingEnabled
      if (source == null || deviceId == null || !canWatch) return@LaunchedEffect
      if (stallReconnectMs == null && firstFrameTimeoutMs == null) return@LaunchedEffect
      LiveVideoProgressWatchdog(options, source, deviceId, frame).watch()
    }
  }
}

private class LiveVideoProgressWatchdog(
  private val options: LiveVideoFrameOptions,
  private val source: VideoStreamSource,
  private val deviceId: String,
  private val frame: MutableState<LiveVideoFrame?>,
) {
  private var noProgressSinceMs = options.nowMs()
  // Retained frames and prior heartbeats cannot count as fresh progress on resume.
  private var lastSeenSequence = frame.value?.sequence ?: -1L
  private var lastSeenActivityMs = source.lastActivityMs.value

  suspend fun watch() {
    while (currentCoroutineContext().isActive) {
      delay(options.stallCheckIntervalMs)
      when (source.state.value) {
        is VideoStreamState.Streaming -> checkStreaming()
        is VideoStreamState.Connecting,
        is VideoStreamState.Idle -> checkFirstFrame()
        else -> {
          noProgressSinceMs = options.nowMs()
          lastSeenSequence = -1L
          lastSeenActivityMs = source.lastActivityMs.value
        }
      }
    }
  }

  private fun checkStreaming() {
    val next = frame.value
    val activityMs = source.lastActivityMs.value
    val stallReconnectMs = options.stallReconnectMs
    if (next != null && next.sequence != lastSeenSequence) {
      lastSeenSequence = next.sequence
      noProgressSinceMs = next.receivedAtMs
    } else if (activityMs > lastSeenActivityMs) {
      lastSeenActivityMs = activityMs
      noProgressSinceMs = activityMs
    } else if (
      stallReconnectMs != null && options.nowMs() - noProgressSinceMs >= stallReconnectMs
    ) {
      reconnect("no frame progress for ${stallReconnectMs}ms while Streaming")
    }
  }

  private fun checkFirstFrame() {
    val timeoutMs = options.firstFrameTimeoutMs
    if (timeoutMs != null && options.nowMs() - noProgressSinceMs >= timeoutMs) {
      reconnect("no first frame within ${timeoutMs}ms")
    }
  }

  private fun reconnect(reason: String) {
    LOG.info("Live mirror for $deviceId reconnecting: $reason")
    noProgressSinceMs = options.nowMs()
    lastSeenSequence = frame.value?.sequence ?: -1L
    lastSeenActivityMs = source.lastActivityMs.value
    source.disconnect()
    source.connect(deviceId)
  }
}
