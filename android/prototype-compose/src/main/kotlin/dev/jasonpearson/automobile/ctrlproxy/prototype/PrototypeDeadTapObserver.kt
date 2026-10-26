package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput

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
      var rejected =
        down.isConsumed ||
          currentEvent.changes.size != 1 ||
          taps.wasHandled(down) ||
          down.position.x < 0 ||
          down.position.y < 0 ||
          down.position.x >= size.width ||
          down.position.y >= size.height
      while (true) {
        val event = awaitPointerEvent(PointerEventPass.Final)
        val change = event.changes.singleOrNull()
        if (change == null || change.id != down.id) {
          rejected = true
        } else {
          rejected =
            rejected ||
              change.isConsumed ||
              (change.position - down.position).getDistance() >= viewConfiguration.touchSlop ||
              change.position.x < 0 ||
              change.position.y < 0 ||
              change.position.x >= size.width ||
              change.position.y >= size.height
          if (!change.pressed) {
            if (!rejected)
              interact(
                PrototypeInteraction.DeadTap(
                  change.position.x / density,
                  change.position.y / density,
                ),
              )
            break
          }
        }
        if (event.changes.none { it.pressed }) break
      }
    }
  }
