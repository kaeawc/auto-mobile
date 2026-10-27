package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntSize

/**
 * Final observes descendant consumption without consuming any event. Gesture-only nodes mark their
 * down as handled separately: consuming it would break the nearest ancestor's ordinary click.
 * Passive text, boxes, images and spacers install neither consumer nor marker and remain dead
 * areas.
 */
internal fun Modifier.prototypeDeadTapObserver(
  taps: PrototypeGestureTaps,
  density: Float,
  interact: (PrototypeInteraction.DeadTap) -> Unit,
): Modifier =
  pointerInput(taps, density) {
    awaitEachGesture {
      val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final)
      val ignoredDown = down.isConsumed || taps.wasHandled(down)
      var rejected =
        ignoredDown || currentEvent.changes.size != 1 || !size.containsPoint(down.position)
      while (true) {
        val event = awaitPointerEvent(PointerEventPass.Final)
        val change = event.changes.singleOrNull()
        if (change == null || change.id != down.id) {
          rejected = true
        } else {
          rejected = rejected || strayed(change, down, size, viewConfiguration.touchSlop)
          if (!change.pressed) {
            if (!rejected) interact(PrototypeInteraction.DeadTap(change.position.x / density, change.position.y / density))
            break
          }
        }
        if (event.changes.none { it.pressed }) break
      }
    }
  }

private fun IntSize.containsPoint(position: Offset): Boolean =
  position.x >= 0 && position.y >= 0 && position.x < width && position.y < height

/** A consumed, dragged-past-slop or out-of-bounds change cannot end in a dead tap. */
private fun strayed(change: PointerInputChange, down: PointerInputChange, size: IntSize, slop: Float) =
  change.isConsumed ||
    (change.position - down.position).getDistance() >= slop ||
    !size.containsPoint(change.position)
