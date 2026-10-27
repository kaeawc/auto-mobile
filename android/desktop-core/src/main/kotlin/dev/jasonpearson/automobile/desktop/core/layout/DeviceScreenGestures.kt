package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChange
import dev.jasonpearson.automobile.desktop.core.control.DeviceGestureStreamHandle
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceGestureStreamCoalescer
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.GestureStreamStep
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint

/**
 * The one pointer-drag gesture for the device screen, which means different things per mode
 * (issue #3350).
 *
 * - **Inspector** — a drag pans the viewport, exactly as before. No daemon input is ever produced
 *   from this mode, which is what keeps the IDE plugin (inspector-only) unchanged.
 * - **Control** — a plain drag is a device swipe. Viewport pan stays available on the modifier that
 *   already gates zoom (Cmd on macOS, Ctrl elsewhere), so control mode loses no navigation
 *   affordance; the modifier is read once at pointer-down, so releasing it mid-drag cannot turn a
 *   pan into a swipe.
 *
 * Which frame the swipe maps through is decided **once**, at pointer-down, by reading
 * [controlFrame] a single time: both endpoints are mapped with that geometry, so a snapshot
 * arriving mid-drag cannot rescale the gesture or split it across two frames. This mirrors what the
 * tap path does with one read per click.
 *
 * A cancelled drag (`drag` returning false — pointer capture lost, window deactivated) emits
 * nothing. Threshold and out-of-bounds rules are deliberately **not** applied here; they belong to
 * the pure `DeviceDragGesturePolicy` the caller runs, so a non-Compose client shares them.
 *
 * @param controlFrame reads the current snapshot + its mapping geometry; null makes control-mode
 *   drag inert (the caller is rendering inspector mode anyway).
 * @param onPan receives each incremental pan delta, in viewport pixels — including the travel past
 *   touch slop on the move that crossed it, which `awaitTouchSlopOrCancellation` reports separately
 *   from the drag loop. The sum of the deltas therefore depends only on the pointer's total
 *   displacement, not on how many move events it arrived in.
 * @param onSwipe receives the pinned snapshot and the raw mapped start/end. Never called in
 *   inspector mode, on a pan, or on a cancelled drag.
 */
internal suspend fun PointerInputScope.deviceScreenDragGestures(
  controlMode: DeviceScreenControlMode,
  controlFrame: () -> Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?,
  onPan: (Offset) -> Unit,
  onSwipe: (DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit,
  /**
   * Streaming (real-time) drag seam (issue: streaming gesture input). Called once, at touch-slop,
   * in control mode with the pinned snapshot and the mapped down point; a non-null handle means the
   * drag streams live (incremental [DeviceGestureStreamHandle.move]s throttled to frame cadence,
   * then [DeviceGestureStreamHandle.end] on release/cancel) instead of firing the atomic [onSwipe].
   * Null — the default, or a null return — keeps the atomic path, so the flag-off and inspector
   * cases are exactly the previous behavior.
   */
  beginGestureStream: ((DeviceFrameSnapshot, DevicePoint) -> DeviceGestureStreamHandle?)? = null,
) {
  awaitEachGesture {
    val down = awaitFirstDown(requireUnconsumed = false)
    val panning =
      controlMode != DeviceScreenControlMode.Control || currentEvent.isZoomModifierPressed()
    // Pin the mapping authority for the WHOLE drag at pointer-down.
    val frame = if (panning) null else controlFrame() ?: return@awaitEachGesture
    // The move that CROSSES touch slop carries real travel past the slop threshold, and it is
    // reported here rather than in the drag loop below. Dropping it would make a
    // one-move-then-release pan move the viewport by exactly zero, and leave any longer pan
    // permanently lagging the pointer by that first delta. Applying `overSlop` is what the stock
    // `detectDragGestures` this replaced already did.
    var overSlop = Offset.Zero
    val change =
      awaitTouchSlopOrCancellation(down.id) { changed, crossed ->
        changed.consume()
        overSlop = crossed
      } ?: return@awaitEachGesture
    // Pan only: a swipe reports its endpoints from `down.position` and the last drag position, so
    // it neither needs nor is affected by this delta.
    if (panning) onPan(overSlop)
    // Track the pointer's own event timestamps so a swipe can be replayed at the speed the user
    // flicked (issue: fling strength). `uptimeMillis` is the toolkit's monotonic event clock, so
    // last-minus-down is the real gesture duration regardless of how many move events arrived.

    // Decide stream vs atomic once, now that this is confirmed a control drag (past slop). The
    // handle, if any, owns this drag until release; the coalescer throttles host samples to the
    // wire cadence. Both stay null on a pan, in inspector mode, or when streaming is unavailable.
    val streaming =
      if (!panning && frame != null) {
        val (snapshot, geometry) = frame
        val downDevice =
          DeviceScreenCoordinateMapper.viewportToDevice(
            ViewportPoint(down.position.x, down.position.y),
            geometry,
          )
        beginGestureStream?.invoke(snapshot, downDevice)
      } else {
        null
      }
    val coalescer = if (streaming != null) DeviceGestureStreamCoalescer() else null

    // A streamed drag MUST send its terminal end even if this pointerInput coroutine is cancelled
    // mid-drag (controlMode change, surface removed): the handle's end() is what closes the event
    // channel, so skipping it leaves the stream consumer awaiting the channel forever while holding
    // the single input FIFO slot, wedging all later input (issue: streaming gesture input). The
    // finally lifts in place with a cancelling end when the normal release path did not run.
    finishDeviceDrag(
      DeviceDragContext(down, change, panning, frame, streaming, coalescer, onPan, onSwipe),
    )
  }
}

private suspend fun androidx.compose.ui.input.pointer.AwaitPointerEventScope.finishDeviceDrag(
  context: DeviceDragContext,
) {
  with(context) {
    try {
      val completed = drag(change.id) { dragged -> context.moveDeviceDrag(dragged) }

      if (streaming != null && frame != null) {
        // A streamed drag ends on release with the exact final point; a cancelled drag (pointer
        // capture lost, window deactivated) lifts in place so a partial drag is abandoned cleanly.
        val geometry = frame.second
        val endDevice =
          DeviceScreenCoordinateMapper.viewportToDevice(
            ViewportPoint(lastPosition.x, lastPosition.y),
            geometry,
          )
        streaming.end(endDevice, cancel = !completed)
        streamReleased = true
        return
      }

      if (!completed || frame == null) return
      val (snapshot, geometry) = frame
      val gestureDurationMs = (lastUptimeMs - down.uptimeMillis).coerceAtLeast(0L).toInt()
      onSwipe(
        snapshot,
        DeviceScreenCoordinateMapper.viewportToDevice(
          ViewportPoint(down.position.x, down.position.y),
          geometry,
        ),
        DeviceScreenCoordinateMapper.viewportToDevice(
          ViewportPoint(lastPosition.x, lastPosition.y),
          geometry,
        ),
        gestureDurationMs,
      )
    } finally {
      if (streaming != null && frame != null && !streamReleased) {
        val geometry = frame.second
        val endDevice =
          DeviceScreenCoordinateMapper.viewportToDevice(
            ViewportPoint(lastPosition.x, lastPosition.y),
            geometry,
          )
        streaming.end(endDevice, cancel = true)
      }
    }
  }
}

private fun DeviceDragContext.moveDeviceDrag(
  dragged: androidx.compose.ui.input.pointer.PointerInputChange,
) {

  // Read the delta BEFORE consuming: `positionChange()` reports Offset.Zero once the change
  // is consumed, so consuming first silently zeroes every pan step.
  val delta = dragged.positionChange()
  dragged.consume()
  if (panning) onPan(delta)
  lastPosition = dragged.position
  lastUptimeMs = dragged.uptimeMillis
  if (streaming != null && coalescer != null && frame != null) {
    val geometry = frame.second
    val moved =
      DeviceScreenCoordinateMapper.viewportToDevice(
        ViewportPoint(dragged.position.x, dragged.position.y),
        geometry,
      )
    // Throttle to the frame cadence; a coalesced sample is superseded by a later move or
    // the
    // exact release point sent below, so nothing visible is lost.
    if (coalescer.offer(moved.x, moved.y, dragged.uptimeMillis) is GestureStreamStep.Emit) {
      streaming.move(moved)
    }
  }
}

private data class DeviceDragContext(
  val down: androidx.compose.ui.input.pointer.PointerInputChange,
  val change: androidx.compose.ui.input.pointer.PointerInputChange,
  val panning: Boolean,
  val frame: Pair<DeviceFrameSnapshot, DeviceScreenGeometry>?,
  val streaming: DeviceGestureStreamHandle?,
  val coalescer: DeviceGestureStreamCoalescer?,
  val onPan: (Offset) -> Unit,
  val onSwipe: (DeviceFrameSnapshot, DevicePoint, DevicePoint, Int) -> Unit,
) {
  var lastPosition = change.position
  var lastUptimeMs = change.uptimeMillis
  var streamReleased = false
}
