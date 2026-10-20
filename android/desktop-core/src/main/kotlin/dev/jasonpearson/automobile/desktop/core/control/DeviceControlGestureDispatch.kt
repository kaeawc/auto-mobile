package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.GestureInputStream
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.domain.DeviceDragDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesture
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import kotlinx.coroutines.channels.Channel

/**
 * The streaming consumer. Opens a persistent gesture stream when the client supports it and relays
 * start → moves → end live; otherwise drains the events and dispatches one atomic swipe, so the
 * caller emits the same event sequence regardless of daemon/runner capability.
 */
internal suspend fun DeviceControlSession.streamGesture(
  command: DeviceControlInputCommand.StreamGesture,
  onError: (String) -> Unit,
) {
  val stream = command.client?.openGestureStream(command.platform, command.snapshot.deviceId)
  if (stream == null) {
    fallbackAtomicSwipe(command, onError)
    return
  }
  var failure: String? = null
  try {
    val started =
      stream.start(command.gestureId, command.start.x.toDouble(), command.start.y.toDouble())
    failure = if (started.success) null else started.error ?: "Gesture start failed"
    if (failure == null) {
      for (event in command.events) {
        val result = relayGestureEvent(stream, command.gestureId, event)
        if (!result.success) {
          failure = result.error ?: gestureEventFailure(event)
          break
        }
        if (event is GestureStreamEvent.End) break
      }
    }
  } finally {
    stream.close()
  }
  if (failure != null) onError(failure)
}

/**
 * Fallback for a client that cannot stream: collect the drag's release point and dispatch a single
 * atomic swipe, applying the same [DeviceDragGesturePolicy] the one-shot [swipe] path uses (a
 * below-threshold or cancelled drag sends nothing).
 */
internal suspend fun DeviceControlSession.fallbackAtomicSwipe(
  command: DeviceControlInputCommand.StreamGesture,
  onError: (String) -> Unit,
) {
  for (event in command.events) {
    if (event is GestureStreamEvent.End) {
      if (event.cancel) return
      val decision =
        DeviceDragGesturePolicy.evaluate(
          DeviceDragGesture(
            start = command.start,
            end = event.point,
            deviceWidth = command.snapshot.deviceWidth,
            deviceHeight = command.snapshot.deviceHeight,
            coordinateSpace = command.snapshot.coordinateSpace,
            nativeScale = command.snapshot.nativeScale,
          ),
        )
      if (decision is DeviceDragDecision.Swipe) {
        forwarder.forwardSwipe(
          start = decision.start,
          end = decision.end,
          durationMs = decision.durationMs,
          target =
            dev.jasonpearson.automobile.desktop.core.control.DeviceInputTarget(
              client = command.client,
              platform = command.platform,
              deviceId = command.snapshot.deviceId,
              frameContext = command.snapshot.frameContext,
              onError = onError,
            ),
        )
      }
      return
    }
  }
}

/** Drain and close a gesture event channel without acting on it (a rejected/aborted stream). */
internal suspend fun DeviceControlSession.drainAndClose(events: Channel<GestureStreamEvent>) {
  for (event in events) {
    if (event is GestureStreamEvent.End) break
  }
}

private fun relayGestureEvent(
  stream: GestureInputStream,
  gestureId: String,
  event: GestureStreamEvent,
): InputActionResult =
  when (event) {
    is GestureStreamEvent.Move ->
      stream.move(gestureId, event.point.x.toDouble(), event.point.y.toDouble())
    is GestureStreamEvent.End ->
      stream.end(gestureId, event.point.x.toDouble(), event.point.y.toDouble(), event.cancel)
  }

private fun gestureEventFailure(event: GestureStreamEvent): String =
  when (event) {
    is GestureStreamEvent.Move -> "Gesture move failed"
    is GestureStreamEvent.End -> "Gesture end failed"
  }
