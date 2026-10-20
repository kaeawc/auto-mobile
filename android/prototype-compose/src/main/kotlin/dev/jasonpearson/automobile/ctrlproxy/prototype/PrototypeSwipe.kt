package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.abs

/**
 * The swipe-actions gesture rules, as pure functions so the same numbers can be pinned in tests and
 * mirrored by the iOS agent (`PrototypeSwipe.swift`). Offsets are pixels; a positive offset drags
 * the row right and reveals `start`, a negative one reveals `end`. Velocities are pixels per
 * second.
 */
internal object PrototypeSwipeTuning {
  /** Width of one revealed button, in dp. */
  const val BUTTON_WIDTH_DP = 80f
  /** A release past this fraction of the revealed width leaves the row open. */
  const val OPEN_FRACTION = 0.4f
  /** A fling at least this fast (dp/s) opens or closes regardless of position. */
  const val OPEN_VELOCITY_DP = 500f
  /** With `fullSwipe`, a release past this fraction of the row width runs the first action. */
  const val FULL_FRACTION = 0.6f
  /** With `fullSwipe`, a fling at least this fast (dp/s) past the revealed width runs it. */
  const val FULL_VELOCITY_DP = 1800f
  /** Beyond the free range a drag moves this fraction of the finger's travel. */
  const val RUBBER_BAND = 0.3f
}

internal enum class SwipeSide {
  START,
  END,
}

/** The measured row: revealed widths per side (0 when a side has no actions) and the row width. */
internal data class SwipeGeometry(
  val startWidth: Float,
  val endWidth: Float,
  val rowWidth: Float,
  val fullSwipe: Boolean,
  val density: Float,
) {
  fun widthOf(side: SwipeSide): Float = if (side == SwipeSide.START) startWidth else endWidth
}

internal sealed interface SwipeSettle {
  data object Closed : SwipeSettle

  data class Open(val side: SwipeSide) : SwipeSettle

  /** The first action of [side] runs and the row closes. */
  data class Full(val side: SwipeSide) : SwipeSettle
}

private fun sideOf(offset: Float) = if (offset > 0f) SwipeSide.START else SwipeSide.END

/** The offset a finger drag of [raw] pixels shows: free up to the reveal, then rubber-banded. */
internal fun swipeRubberBand(raw: Float, g: SwipeGeometry): Float {
  if (raw == 0f) return 0f
  val side = sideOf(raw)
  val width = g.widthOf(side)
  if (width <= 0f) return 0f
  val free = if (g.fullSwipe) g.rowWidth else width
  val distance = abs(raw)
  val shown =
    if (distance <= free) distance else free + (distance - free) * PrototypeSwipeTuning.RUBBER_BAND
  return if (raw > 0f) shown else -shown
}

/** Where a release at [offset] with [velocity] settles. */
internal fun swipeSettle(offset: Float, velocity: Float, g: SwipeGeometry): SwipeSettle {
  if (offset == 0f) return SwipeSettle.Closed
  val side = sideOf(offset)
  val width = g.widthOf(side)
  if (width <= 0f) return SwipeSettle.Closed
  val distance = abs(offset)
  // Positive when the finger is still moving the row further open.
  val opening = if (offset > 0f) velocity else -velocity
  if (
    g.fullSwipe &&
      (distance >= PrototypeSwipeTuning.FULL_FRACTION * g.rowWidth ||
        (distance > width && opening >= PrototypeSwipeTuning.FULL_VELOCITY_DP * g.density))
  ) {
    return SwipeSettle.Full(side)
  }
  val fling = PrototypeSwipeTuning.OPEN_VELOCITY_DP * g.density
  return when {
    opening >= fling -> SwipeSettle.Open(side)
    opening <= -fling -> SwipeSettle.Closed
    distance >= PrototypeSwipeTuning.OPEN_FRACTION * width -> SwipeSettle.Open(side)
    else -> SwipeSettle.Closed
  }
}

/** The resting offset of a settle: closed, exactly the revealed width, or off the row. */
internal fun swipeRestOffset(settle: SwipeSettle, g: SwipeGeometry): Float =
  when (settle) {
    SwipeSettle.Closed -> 0f
    is SwipeSettle.Open -> signed(settle.side, g.widthOf(settle.side))
    is SwipeSettle.Full -> signed(settle.side, g.rowWidth)
  }

private fun signed(side: SwipeSide, value: Float) = if (side == SwipeSide.START) value else -value

/**
 * Widths of the buttons on a side for a revealed [reveal]: the first (edge) one absorbs any extra.
 */
internal fun swipeButtonWidths(count: Int, reveal: Float, buttonWidth: Float): List<Float> {
  if (count <= 0) return emptyList()
  val base = List(count) { buttonWidth }
  val extra = (reveal - buttonWidth * count).coerceAtLeast(0f)
  return listOf(base[0] + extra) + base.drop(1)
}

/** One open row at a time: opening a row reports the row that must close. Observable by rows. */
internal class SwipeCoordinator {
  var openRow: String? by mutableStateOf(null)
    private set

  var openSide: SwipeSide = SwipeSide.END
    private set

  /** Marks [id] open on [side] and returns the previously open row, if a different one. */
  fun opened(id: String, side: SwipeSide = SwipeSide.END): String? {
    val previous = openRow?.takeIf { it != id }
    openRow = id
    openSide = side
    return previous
  }

  fun closed(id: String) {
    if (openRow == id) openRow = null
  }

  fun isOpen(id: String): Boolean = openRow == id
}

internal val LocalPrototypeSwipeCoordinator = compositionLocalOf<SwipeCoordinator?> { null }
