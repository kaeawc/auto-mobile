package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput

internal val LocalPrototypeGestureTaps = compositionLocalOf { PrototypeGestureTaps() }

/** Captures the nearest clickable's callback for a gesture-only child's double-tap window. */
internal class PrototypeGestureTaps {
  class Pending {
    var tap: (() -> Unit)? = null
    var suppress = false
  }

  private var pending: Pending? = null

  fun begin(): Pending = Pending().also { pending = it }

  fun tap(action: () -> Unit) {
    val waiting = pending
    pending = null
    if (waiting == null) action() else if (!waiting.suppress) waiting.tap = action
  }

  fun suppress(waiting: Pending) {
    waiting.suppress = true
    pending = waiting
  }

  fun finish(waiting: Pending, singleTap: Boolean) {
    if (pending === waiting) pending = null
    if (singleTap) waiting.tap?.invoke()
    waiting.tap = null
  }
}

/** Observe Initial without consuming a plain tap; detectTapGestures consumes even without onTap. */
internal fun Modifier.prototypeGestureObserver(
  taps: PrototypeGestureTaps,
  presses: MutableInteractionSource,
  onLongPress: (() -> Unit)?,
  onDoubleTap: (() -> Unit)?,
): Modifier =
  pointerInput(taps, presses, onLongPress, onDoubleTap) {
    awaitEachGesture {
      val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
      val first = observedPress(down, onLongPress, presses) ?: return@awaitEachGesture
      val up = first.up ?: return@awaitEachGesture
      if (onDoubleTap == null) return@awaitEachGesture
      val waiting = taps.begin()
      try {
        val secondDown =
          withTimeoutOrNull(viewConfiguration.doubleTapTimeoutMillis) {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
          }
        if (
          secondDown == null ||
            secondDown.uptimeMillis - up.uptimeMillis < viewConfiguration.doubleTapMinTimeMillis ||
            (secondDown.position - up.position).getDistance() > viewConfiguration.touchSlop
        ) {
          taps.finish(waiting, singleTap = true)
          return@awaitEachGesture
        }
        val second = observedPress(secondDown, onLongPress, presses)
        if (second?.up != null) {
          second.up.consume()
          onDoubleTap()
        }
        if (second == null || second.up != null) {
          // An ancestor combinedClickable may fall back to onClick when its second up is consumed.
          // Keep suppression through Main, then clear it in Final so the next gesture is untouched.
          taps.suppress(waiting)
          awaitPointerEvent(PointerEventPass.Final)
          taps.finish(waiting, singleTap = false)
        } else {
          taps.finish(waiting, singleTap = true)
        }
      } finally {
        taps.finish(waiting, singleTap = false)
      }
    }
  }

private class ObservedPress(val up: PointerInputChange?)

/** Null means a completed long press; a null up means slop/multitouch cancelled the press. */
private suspend fun AwaitPointerEventScope.observedPress(
  down: PointerInputChange,
  onLongPress: (() -> Unit)?,
  presses: MutableInteractionSource,
): ObservedPress? {
  val press = PressInteraction.Press(down.position)
  presses.tryEmit(press)
  try {
    return observedPressRelease(down, onLongPress)
  } finally {
    presses.tryEmit(PressInteraction.Release(press))
  }
}

private suspend fun AwaitPointerEventScope.observedPressRelease(
  down: PointerInputChange,
  onLongPress: (() -> Unit)?,
): ObservedPress? {
  if (onLongPress == null) return ObservedPress(observedUp(down))
  val released =
    withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { ObservedPress(observedUp(down)) }
  if (released != null) return released
  onLongPress()
  // Only a recognized hold consumes events, cancelling the ancestor's clickable.
  currentEvent.changes.forEach { it.consume() }
  do {
    val event = awaitPointerEvent(PointerEventPass.Initial)
    event.changes.forEach { it.consume() }
  } while (event.changes.any { it.pressed })
  return null
}

private suspend fun AwaitPointerEventScope.observedUp(
  down: PointerInputChange,
): PointerInputChange? {
  while (true) {
    val event = awaitPointerEvent(PointerEventPass.Initial)
    val change = event.changes.singleOrNull() ?: return null
    if (
      change.id != down.id ||
        change.isConsumed ||
        (change.position - down.position).getDistance() > viewConfiguration.touchSlop
    )
      return null
    if (!change.pressed) return change
    // Ancestor clickables consume down; scrolling consumes movement and cancels this observer.
    val final = awaitPointerEvent(PointerEventPass.Final)
    if (final.changes.any { it.isConsumed && it.position != it.previousPosition }) return null
  }
}
