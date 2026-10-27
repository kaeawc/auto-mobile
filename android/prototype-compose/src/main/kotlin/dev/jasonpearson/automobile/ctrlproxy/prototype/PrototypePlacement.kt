package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.view.Gravity
import android.view.WindowManager
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.PrototypeModeValue

@InternalAutoMobilePrototypeApi
sealed interface PrototypePlacement {
  /**
   * [scrim] is the literal colour of a single hex scrim. [scrimSpec] is the authored slot, which
   * the host resolves against the theme when it is a role name or a `{light, dark}` pair.
   */
  data class Fullscreen(val scrim: Color? = null, val scrimSpec: PrototypeModeValue? = null) :
    PrototypePlacement

  data class Sheet(val edge: Edge, val sizeDp: Float) : PrototypePlacement {
    init {
      require(sizeDp.isFinite() && sizeDp > 0) { "Sheet size must be positive and finite" }
    }
  }

  data class Floating(
    val gravity: Int = Gravity.TOP or Gravity.START,
    val offsetXDp: Float = 0f,
    val offsetYDp: Float = 0f,
  ) : PrototypePlacement {
    init {
      require(offsetXDp.isFinite() && offsetYDp.isFinite()) { "Offsets must be finite" }
    }
  }

  enum class Edge {
    TOP,
    BOTTOM,
    START,
    END,
  }
}

/**
 * The window layer a prototype is stacked on (#10496). [SYSTEM] is an accessibility overlay above
 * system UI, including the shade, keyboard and SystemUI's screenshot flash and preview. [APP] is an
 * application overlay just above apps, so all of those draw over it the way they do over a real
 * app; it needs SYSTEM_ALERT_WINDOW, which the controller checks before showing.
 */
@SuppressLint("InlinedApi") // APP is only requested on API 26+; the controller refuses it below.
@InternalAutoMobilePrototypeApi
enum class PrototypeWindowLayer(val windowType: Int) {
  SYSTEM(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY),
  APP(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);

  companion object {
    /** Absent means [SYSTEM], the behaviour before layers existed. */
    fun fromWire(value: String?): PrototypeWindowLayer =
      when (value) {
        null,
        "system" -> SYSTEM
        "app" -> APP
        else -> error("window.layer: Unknown layer")
      }
  }
}

/** Window-space pixels; independent of Compose and device density. */
internal data class PrototypeTargetRect(
  val left: Float,
  val top: Float,
  val right: Float,
  val bottom: Float,
)

internal data class PrototypeBubbleSize(val width: Float, val height: Float)

internal data class PrototypeBubblePlacement(
  val caret: String,
  val x: Float,
  val y: Float,
  val caretOffset: Float,
)

internal data class PrototypeBubbleOptions(
  val rtl: Boolean,
  val caret: String,
  val gap: Float,
  val margin: Float,
  val cornerRadius: Float,
)

/** Caret names are bubble edges: top places the bubble below its target. */
internal fun placePrototypeBubble(
  target: PrototypeTargetRect,
  bubble: PrototypeBubbleSize,
  window: PrototypeTargetRect,
  options: PrototypeBubbleOptions,
): PrototypeBubblePlacement {
  val space = PrototypeBubbleSpace(target, bubble, window, options)
  val side = space.resolveSide()
  val centerX = (target.left + target.right) / 2f
  val centerY = (target.top + target.bottom) / 2f
  val vertical = side in setOf("top", "bottom")
  val bubbleOnRight = (side == "start") != options.rtl
  val rawX =
    if (vertical) centerX - bubble.width / 2f
    else if (bubbleOnRight) target.right + options.gap else target.left - options.gap - bubble.width
  val rawY =
    if (!vertical) centerY - bubble.height / 2f
    else if (side == "top") target.bottom + options.gap
    else target.top - options.gap - bubble.height
  val x = rawX.coerceIn(space.left, (space.right - bubble.width).coerceAtLeast(space.left))
  val y = rawY.coerceIn(space.top, (space.bottom - bubble.height).coerceAtLeast(space.top))
  val length = if (vertical) bubble.width else bubble.height
  val inset = options.cornerRadius.coerceIn(0f, length / 2f)
  val offset =
    (if (vertical) centerX - x else centerY - y).coerceIn(
      inset,
      (length - inset).coerceAtLeast(inset),
    )
  return PrototypeBubblePlacement(side, x, y, offset)
}

private class PrototypeBubbleSpace(
  val target: PrototypeTargetRect,
  val bubble: PrototypeBubbleSize,
  window: PrototypeTargetRect,
  val options: PrototypeBubbleOptions,
) {
  val left = window.left + options.margin
  val top = window.top + options.margin
  val right = window.right - options.margin
  val bottom = window.bottom - options.margin

  private fun room(side: String): Float =
    when (side) {
      "top" -> bottom - target.bottom - options.gap
      "bottom" -> target.top - top - options.gap
      "start" ->
        if (!options.rtl) right - target.right - options.gap else target.left - left - options.gap
      else ->
        if (!options.rtl) target.left - left - options.gap else right - target.right - options.gap
    }

  private fun fits(side: String) =
    room(side) >= if (side in setOf("top", "bottom")) bubble.height else bubble.width

  fun resolveSide(): String {
    val preferred = if (options.caret == "auto") "top" else options.caret
    val opposite =
      when (preferred) {
        "top" -> "bottom"
        "bottom" -> "top"
        "start" -> "end"
        else -> "start"
      }
    return when {
      fits(preferred) -> preferred
      fits(opposite) -> opposite
      options.caret == "auto" && fits("start") -> "start"
      options.caret == "auto" && fits("end") -> "end"
      room(opposite) > room(preferred) -> opposite
      else -> preferred
    }
  }
}
