package dev.jasonpearson.automobile.ctrlproxy.prototype

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
import dev.jasonpearson.automobile.protocol.PrototypeBoundsAnchor
import dev.jasonpearson.automobile.protocol.PrototypeElementAnchor
import dev.jasonpearson.automobile.protocol.PrototypeNode
import kotlin.math.roundToInt

/** `cover` lays the node over the anchor bounds; the edges align the same node edge to them. */
enum class PrototypeAnchorAlignment {
  COVER,
  TOP,
  BOTTOM,
  START,
  END;

  companion object {
    fun fromWire(value: String?): PrototypeAnchorAlignment =
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
fun prototypeAnchorCovers(anchor: PrototypeBoundsAnchor): Boolean =
  PrototypeAnchorAlignment.fromWire(anchor.alignment) == PrototypeAnchorAlignment.COVER

/**
 * The anchored node's screen rectangle in px. [anchor] bounds and offset are screen-space dp and
 * convert with [density]. Cover adopts the bounds; an edge alignment keeps the node's measured
 * [nodeWidthPx] x [nodeHeightPx], puts its matching edge on the bounds' edge and centres it along
 * the other axis. Start and end follow [layoutDirection]. The offset is applied last, in screen
 * axes.
 */
fun prototypeAnchorRect(
  anchor: PrototypeBoundsAnchor,
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
    when (PrototypeAnchorAlignment.fromWire(anchor.alignment)) {
      PrototypeAnchorAlignment.COVER ->
        return shift(Rect(left, top, left + width, top + height), anchor, density)
      PrototypeAnchorAlignment.TOP -> Offset(centredX, top)
      PrototypeAnchorAlignment.BOTTOM -> Offset(centredX, top + height - nodeHeightPx)
      PrototypeAnchorAlignment.START ->
        Offset(if (rtl) left + width - nodeWidthPx else left, centredY)
      PrototypeAnchorAlignment.END ->
        Offset(if (rtl) left else left + width - nodeWidthPx, centredY)
    }
  return shift(
    Rect(origin.x, origin.y, origin.x + nodeWidthPx, origin.y + nodeHeightPx),
    anchor,
    density,
  )
}

private fun shift(rect: Rect, anchor: PrototypeBoundsAnchor, density: Float): Rect {
  val offset = anchor.offset ?: return rect
  return rect.translate(offset.x.toFloat() * density, offset.y.toFloat() * density)
}

/**
 * Where the prototype window sits on screen, and how a floating window follows an anchored root.
 * [originOnScreen] is the screen position, in px, of the window's own (0, 0): anchors are screen
 * coordinates, so a node subtracts it together with its position inside the window (system bars,
 * cutout, host chrome and authored padding included). [moveTo] is non-null only for a floating
 * window, whose root anchor positions the window itself so the rest of the app stays touchable.
 */
class PrototypeWindowGeometry(
  val originOnScreen: () -> Offset,
  val moveTo: ((IntOffset) -> Unit)? = null,
)

/** The window origin of [view]: its screen position less its position inside its window. */
fun prototypeViewWindowOrigin(view: View): Offset {
  val screen = IntArray(2)
  val window = IntArray(2)
  view.getLocationOnScreen(screen)
  view.getLocationInWindow(window)
  return Offset((screen[0] - window[0]).toFloat(), (screen[1] - window[1]).toFloat())
}

/** Null outside a host window; the renderer then reads the window origin from its own view. */
val LocalPrototypeWindowGeometry = staticCompositionLocalOf<PrototypeWindowGeometry?> { null }

@Composable
internal fun currentPrototypeWindowGeometry(): PrototypeWindowGeometry {
  LocalPrototypeWindowGeometry.current?.let {
    return it
  }
  val view = LocalView.current
  return PrototypeWindowGeometry({ prototypeViewWindowOrigin(view) })
}

/**
 * Lays the node out at [anchor]'s screen rectangle, translated from the slot it is placed in. A
 * node below the root sits in its window's anchor layer, which takes no space, so its parent
 * neither reserves a slot for it nor clips it (#10803). A floating window's root ([windowRoot])
 * instead stays at the window's (0, 0) and moves the window onto the rectangle through [geometry]'s
 * `moveTo`.
 */
internal fun Modifier.prototypeAnchor(
  anchor: PrototypeBoundsAnchor,
  geometry: PrototypeWindowGeometry,
  windowRoot: Boolean,
): Modifier = layout { measurable, constraints ->
  val placeable =
    if (prototypeAnchorCovers(anchor)) {
      val width = (anchor.bounds.width.toFloat() * density).roundToInt().coerceAtLeast(0)
      val height = (anchor.bounds.height.toFloat() * density).roundToInt().coerceAtLeast(0)
      measurable.measure(Constraints.fixed(width, height))
    } else {
      measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    }
  val rect =
    prototypeAnchorRect(
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
fun requireResolvedPrototypeAnchors(root: PrototypeNode) {
  fun visit(node: PrototypeNode, path: String) {
    require(node.anchor !is PrototypeElementAnchor) {
      "$path.anchor: Element anchors must be resolved to bounds by the host; update the AutoMobile host"
    }
    prototypeChildEntries(node, path, bind = false).forEach { visit(it.node, it.path) }
  }
  visit(root, "root")
}
