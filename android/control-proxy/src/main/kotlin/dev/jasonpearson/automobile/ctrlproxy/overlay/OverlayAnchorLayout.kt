package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.OverlayBoundsAnchor
import dev.jasonpearson.automobile.protocol.OverlayElementAnchor
import dev.jasonpearson.automobile.protocol.OverlayNode
import kotlin.math.roundToInt

/** `cover` lays the node over the anchor bounds; the edges align the same node edge to them. */
enum class OverlayAnchorAlignment {
  COVER,
  TOP,
  BOTTOM,
  START,
  END;

  companion object {
    fun fromWire(value: String?): OverlayAnchorAlignment =
      when (value) {
        null,
        "cover" -> COVER
        "top" -> TOP
        "bottom" -> BOTTOM
        "start" -> START
        "end" -> END
        else -> error("anchor.alignment: Unknown alignment")
      }
  }
}

/** Whether [anchor] lays the node over its bounds, sizing it to them. */
fun overlayAnchorCovers(anchor: OverlayBoundsAnchor): Boolean =
  OverlayAnchorAlignment.fromWire(anchor.alignment) == OverlayAnchorAlignment.COVER

/**
 * The anchored node's screen rectangle in px. [anchor] bounds and offset are screen-space dp and
 * convert with [density]. Cover adopts the bounds; an edge alignment keeps the node's measured
 * [nodeWidthPx] x [nodeHeightPx], puts its matching edge on the bounds' edge and centres it along
 * the other axis. Start and end follow [layoutDirection]. The offset is applied last, in screen
 * axes.
 */
fun overlayAnchorRect(
  anchor: OverlayBoundsAnchor,
  density: Float,
  nodeWidthPx: Float,
  nodeHeightPx: Float,
  layoutDirection: LayoutDirection,
): Rect {
  val left = anchor.bounds.x.toFloat() * density
  val top = anchor.bounds.y.toFloat() * density
  val width = anchor.bounds.width.toFloat() * density
  val height = anchor.bounds.height.toFloat() * density
  val centredX = left + (width - nodeWidthPx) / 2f
  val centredY = top + (height - nodeHeightPx) / 2f
  val rtl = layoutDirection == LayoutDirection.Rtl
  val origin =
    when (OverlayAnchorAlignment.fromWire(anchor.alignment)) {
      OverlayAnchorAlignment.COVER ->
        return shift(Rect(left, top, left + width, top + height), anchor, density)
      OverlayAnchorAlignment.TOP -> Offset(centredX, top)
      OverlayAnchorAlignment.BOTTOM -> Offset(centredX, top + height - nodeHeightPx)
      OverlayAnchorAlignment.START ->
        Offset(if (rtl) left + width - nodeWidthPx else left, centredY)
      OverlayAnchorAlignment.END -> Offset(if (rtl) left else left + width - nodeWidthPx, centredY)
    }
  return shift(
    Rect(origin.x, origin.y, origin.x + nodeWidthPx, origin.y + nodeHeightPx),
    anchor,
    density,
  )
}

private fun shift(rect: Rect, anchor: OverlayBoundsAnchor, density: Float): Rect {
  val offset = anchor.offset ?: return rect
  return rect.translate(offset.x.toFloat() * density, offset.y.toFloat() * density)
}

/**
 * Where the overlay window sits on screen, and how a floating window follows an anchored root.
 * [originOnScreen] is the screen position, in px, of the window's own (0, 0): anchors are screen
 * coordinates, so a node subtracts it together with its position inside the window (system bars,
 * cutout, host chrome and authored padding included). [moveTo] is non-null only for a floating
 * window, whose root anchor positions the window itself so the rest of the app stays touchable.
 */
class OverlayWindowGeometry(
  val originOnScreen: () -> Offset,
  val moveTo: ((IntOffset) -> Unit)? = null,
)

/** The window origin of [view]: its screen position less its position inside its window. */
fun overlayViewWindowOrigin(view: View): Offset {
  val screen = IntArray(2)
  val window = IntArray(2)
  view.getLocationOnScreen(screen)
  view.getLocationInWindow(window)
  return Offset((screen[0] - window[0]).toFloat(), (screen[1] - window[1]).toFloat())
}

/** Null outside a host window; the renderer then reads the window origin from its own view. */
val LocalOverlayWindowGeometry = staticCompositionLocalOf<OverlayWindowGeometry?> { null }

@Composable
internal fun currentOverlayWindowGeometry(): OverlayWindowGeometry {
  LocalOverlayWindowGeometry.current?.let {
    return it
  }
  val view = LocalView.current
  return OverlayWindowGeometry({ overlayViewWindowOrigin(view) })
}

/**
 * Lays the node out at [anchor]'s screen rectangle, translated from the slot it is placed in. A
 * node below the root sits in its window's anchor layer, which takes no space, so its parent
 * neither reserves a slot for it nor clips it (#10803). A floating window's root ([windowRoot])
 * instead stays at the window's (0, 0) and moves the window onto the rectangle through [geometry]'s
 * `moveTo`.
 */
internal fun Modifier.overlayAnchor(
  anchor: OverlayBoundsAnchor,
  geometry: OverlayWindowGeometry,
  windowRoot: Boolean,
): Modifier = layout { measurable, constraints ->
  val placeable =
    if (overlayAnchorCovers(anchor)) {
      val width = (anchor.bounds.width.toFloat() * density).roundToInt().coerceAtLeast(0)
      val height = (anchor.bounds.height.toFloat() * density).roundToInt().coerceAtLeast(0)
      measurable.measure(Constraints.fixed(width, height))
    } else {
      measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    }
  val rect =
    overlayAnchorRect(
      anchor,
      density,
      placeable.width.toFloat(),
      placeable.height.toFloat(),
      layoutDirection,
    )
  layout(placeable.width, placeable.height) {
    val slot = coordinates?.positionInWindow() ?: Offset.Zero
    val move = geometry.moveTo
    if (windowRoot && move != null) {
      move(IntOffset((rect.left - slot.x).roundToInt(), (rect.top - slot.y).roundToInt()))
      placeable.place(0, 0)
    } else {
      val origin = geometry.originOnScreen() + slot
      placeable.place((rect.left - origin.x).roundToInt(), (rect.top - origin.y).roundToInt())
    }
  }
}

/**
 * The host resolves every element anchor into screen dp bounds before sending (#9316). One that
 * still arrives was never resolved, and drawing the node unanchored would silently misplace it.
 */
fun requireResolvedOverlayAnchors(root: OverlayNode) {
  fun visit(node: OverlayNode, path: String) {
    require(node.anchor !is OverlayElementAnchor) {
      "$path.anchor: Element anchors must be resolved to bounds by the host; update the AutoMobile host"
    }
    overlayChildEntries(node, path, bind = false).forEach { visit(it.node, it.path) }
  }
  visit(root, "root")
}
