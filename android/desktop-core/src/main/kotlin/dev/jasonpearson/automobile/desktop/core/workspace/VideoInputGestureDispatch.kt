package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.control.GestureStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.GestureInputStream
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.SwipeInput
import dev.jasonpearson.automobile.desktop.core.daemon.isDeviceOwnedRefusal
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.domain.DeviceDragDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesture
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlinx.coroutines.channels.Channel

private val LOG = LoggerFactory.getLogger("VideoInputDispatcher")

internal suspend fun VideoInputDispatcher.streamOrFallback(
  client: AutoMobileClient,
  platformName: String,
  gesture: GestureStreamStart,
  events: Channel<GestureStreamEvent>,
) {
  val snapshot = gesture.snapshot
  val gestureId = gesture.gestureId
  val start = gesture.point

  val stream = client.openGestureStream(platformName, deviceId)
  if (stream == null) {
    fallbackAtomicSwipe(client, platformName, snapshot, start, events)
    return
  }
  tracer.dispatching(deviceId)
  // A rejected start means the runner can't stream this gesture — an older control-proxy artifact
  // that doesn't decode request_gesture_start, or API 24-25. Treat it as unsupported and fall
  // back to one atomic swipe on release so the drag still lands, exactly as when the client
  // cannot stream at all (issue: streaming gesture input). The GestureInputStream contract makes
  // a failed ack terminal: stop, do not keep sending frames, and do not report the gesture acked.
  var startRejected = false
  var refused = false
  var acked = false
  try {
    val started = stream.start(gestureId, start.x.toDouble(), start.y.toDouble())
    if (started.isDeviceOwnedRefusal) {
      // Another session holds the device: an atomic swipe would be refused the same way.
      reportRejected(started)
      refused = true
    } else if (!started.success) {
      LOG.warn(
        "gesture stream start rejected for $deviceId: ${started.error ?: started.action}; " +
          "falling back to atomic swipe",
      )
      startRejected = true
    } else {
      acked = consumeStreamedGesture(stream, gestureId, events)
    }
  } finally {
    stream.close()
  }
  if (refused) {
    drainGestureEvents(events)
    return
  }
  if (startRejected) {
    // The stream is closed; drain the remaining moves/release from the same events channel into
    // one atomic swipe, so the pane emits the same start/move/end regardless of runner support.
    fallbackAtomicSwipe(client, platformName, snapshot, start, events)
    return
  }
  if (acked) tracer.acked(deviceId)
}

internal suspend fun VideoInputDispatcher.consumeStreamedGesture(
  stream: GestureInputStream,
  gestureId: String,
  events: Channel<GestureStreamEvent>,
): Boolean {
  for (event in events) {
    when (event) {
      is GestureStreamEvent.Move -> {
        val result = stream.move(gestureId, event.point.x.toDouble(), event.point.y.toDouble())
        if (!result.success) {
          LOG.warn("gesture stream move rejected for $deviceId: ${result.error ?: result.action}")
          reportRejected(result)
          return false
        }
      }
      is GestureStreamEvent.End -> {
        val result =
          stream.end(gestureId, event.point.x.toDouble(), event.point.y.toDouble(), event.cancel)
        if (!result.success) {
          LOG.warn("gesture stream end rejected for $deviceId: ${result.error ?: result.action}")
          reportRejected(result)
          return false
        }
        return true
      }
    }
  }
  // The channel closed without an End (deactivated mid-drag): not a clean acknowledgement.
  return false
}

internal suspend fun VideoInputDispatcher.fallbackAtomicSwipe(
  client: AutoMobileClient,
  platformName: String,
  snapshot: DeviceFrameSnapshot,
  start: DevicePoint,
  events: Channel<GestureStreamEvent>,
) {
  for (event in events) {
    if (event is GestureStreamEvent.End) {
      if (event.cancel) return
      val decision =
        DeviceDragGesturePolicy.evaluate(
          DeviceDragGesture(
            start = start,
            end = event.point,
            deviceWidth = snapshot.deviceWidth,
            deviceHeight = snapshot.deviceHeight,
            coordinateSpace = snapshot.coordinateSpace,
            nativeScale = snapshot.nativeScale,
          ),
        )
      if (decision is DeviceDragDecision.Swipe) {
        val result =
          client.inputSwipe(
            input =
              SwipeInput(
                startX = decision.start.x.toDouble(),
                startY = decision.start.y.toDouble(),
                endX = decision.end.x.toDouble(),
                endY = decision.end.y.toDouble(),
                platform = platformName,
                deviceId = deviceId,
                durationMs = decision.durationMs,
                frameContext = null,
              ),
          )
        if (!result.success) {
          LOG.warn("video swipe rejected for $deviceId: ${result.error ?: result.action}")
          reportRejected(result)
        }
      }
      return
    }
  }
}

internal suspend fun VideoInputDispatcher.drainGestureEvents(events: Channel<GestureStreamEvent>) {
  for (event in events) {
    if (event is GestureStreamEvent.End) break
  }
}

internal fun VideoInputDispatcher.reportRejected(result: InputActionResult) {
  if (result.isDeviceOwnedRefusal) onDeviceHeldElsewhere()
}

internal data class GestureStreamStart(
  val snapshot: DeviceFrameSnapshot,
  val gestureId: String,
  val point: DevicePoint,
)
