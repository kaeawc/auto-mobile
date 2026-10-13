package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

const val PROTOTYPE_ESCAPE_HOLD_MILLIS = 1_000L
const val PROTOTYPE_ESCAPE_PILL_MILLIS = 5_000L
private const val ESCAPE_POINTER_COUNT = 2

/** Runs on the view's thread and returns a cancellation handle. */
fun interface PrototypeEscapeScheduler {
  fun schedule(delayMillis: Long, block: () -> Unit): () -> Unit
}

data class PrototypeEscapePointer(val id: Int, val x: Float, val y: Float)

enum class PrototypeEscapeAction {
  DOWN,
  POINTER_DOWN,
  MOVE,
  POINTER_UP,
  UP,
  CANCEL,
}

/** Host-owned state, retained per window and cleared on replacement. */
class PrototypeEscapeState {
  var revealed by mutableStateOf(false)
    private set

  var revealCounter by mutableStateOf(0L)
    private set

  fun reveal() {
    revealCounter++
    revealed = true
  }

  fun hide() {
    revealed = false
  }
}

/**
 * Samples contain the pointers still down AFTER the action (lifted pointers are excluded). The
 * scheduled callback recognizes stationary fingers without needing any MOVE event. Movement
 * rejection lasts until the pair changes; returning inside slop cannot restart the same hold.
 */
class PrototypeEscapeTracker(
  touchSlop: Int,
  private val scheduler: PrototypeEscapeScheduler,
  private val onEscape: () -> Unit,
) {
  private val slopSquared = touchSlop.toFloat() * touchSlop
  private var origins = emptyList<PrototypeEscapePointer>()
  private var cancelHold: (() -> Unit)? = null
  private var token: Any? = null
  private var rejected = false
  private var swallowing = false

  /** True means the host must swallow this sample, including the final UP or CANCEL. */
  fun sample(action: PrototypeEscapeAction, pointers: List<PrototypeEscapePointer>): Boolean {
    // A new stream can start after Android stopped delivering the old one without UP/CANCEL.
    if (action == PrototypeEscapeAction.DOWN) reset()
    if (swallowing) {
      if (pointers.isEmpty() || action == PrototypeEscapeAction.CANCEL) reset()
      return true
    }
    if (action == PrototypeEscapeAction.CANCEL || pointers.size != ESCAPE_POINTER_COUNT) {
      reset()
    } else if (!rejected) {
      if (origins.isEmpty()) arm(pointers)
      else if (moved(pointers)) {
        disarm()
        rejected = true
      }
    }
    return false
  }

  fun reset() {
    disarm()
    rejected = false
    swallowing = false
  }

  private fun moved(pointers: List<PrototypeEscapePointer>): Boolean = origins.any { origin ->
    val current = pointers.find { it.id == origin.id }
    if (current == null) true
    else {
      val dx = current.x - origin.x
      val dy = current.y - origin.y
      dx * dx + dy * dy > slopSquared
    }
  }

  private fun arm(pointers: List<PrototypeEscapePointer>) {
    origins = pointers.toList()
    val armed = Any()
    token = armed
    cancelHold =
      scheduler.schedule(PROTOTYPE_ESCAPE_HOLD_MILLIS) {
        if (token === armed) {
          token = null
          cancelHold = null
          swallowing = true
          onEscape()
        }
      }
  }

  private fun disarm() {
    token = null
    cancelHold?.invoke()
    cancelHold = null
    origins = emptyList()
  }
}
