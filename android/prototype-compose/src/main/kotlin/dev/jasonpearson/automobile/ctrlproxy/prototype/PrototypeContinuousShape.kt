package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection

/**
 * Dependency-free continuous-corner approximation. Cubic handles blend 60% toward a squircle from a
 * circular quarter arc. Smoothing tapers to circular at half the short side so full radii remain
 * pills/circles. The existing shape resolves theme tokens and RTL corners first.
 */
internal class PrototypeContinuousShape(private val rounded: Shape) : Shape {
  override fun createOutline(
    size: Size,
    layoutDirection: LayoutDirection,
    density: Density,
  ): Outline {
    val radii =
      prototypeContinuousRadii(rounded, size, layoutDirection, density)
        ?: return rounded.createOutline(size, layoutDirection, density)
    return Outline.Generic(prototypeContinuousPath(size, radii))
  }
}

internal fun prototypeContinuousRadii(
  rounded: Shape,
  size: Size,
  direction: LayoutDirection,
  density: Density,
): List<CornerRadius>? {
  val corners = rounded as? CornerBasedShape ?: return null
  val startTop = corners.topStart.toPx(size, density)
  val endTop = corners.topEnd.toPx(size, density)
  val startBottom = corners.bottomStart.toPx(size, density)
  val endBottom = corners.bottomEnd.toPx(size, density)
  val radii =
    if (direction == LayoutDirection.Ltr) {
      listOf(startTop, endTop, endBottom, startBottom)
    } else listOf(endTop, startTop, startBottom, endBottom)
  return radii.map { CornerRadius(it) }
}

internal data class PrototypeContinuousCorner(
  val start: Offset,
  val first: Offset,
  val second: Offset,
  val end: Offset,
)

/** The control polygon stays inside each corner's quadrant, preventing crossings and overshoot. */
internal fun prototypeContinuousCorners(
  size: Size,
  corners: List<CornerRadius>,
): List<PrototypeContinuousCorner> {
  val limit = size.minDimension.coerceAtLeast(0f) / 2f
  val radii = corners.map { it.x.coerceIn(0f, limit) }
  val w = size.width
  val h = size.height
  val (tl, tr, br, bl) = radii
  fun handle(r: Float): Float {
    val smoothing = if (limit == 0f) 0f else 0.6f * (1f - r / limit)
    return r * (0.5522848f + smoothing * (1f - 0.5522848f))
  }
  val a = handle(tr)
  val b = handle(br)
  val c = handle(bl)
  val d = handle(tl)
  return listOf(
    PrototypeContinuousCorner(
      Offset(w - tr, 0f),
      Offset(w - tr + a, 0f),
      Offset(w, tr - a),
      Offset(w, tr),
    ),
    PrototypeContinuousCorner(
      Offset(w, h - br),
      Offset(w, h - br + b),
      Offset(w - br + b, h),
      Offset(w - br, h),
    ),
    PrototypeContinuousCorner(
      Offset(bl, h),
      Offset(bl - c, h),
      Offset(0f, h - bl + c),
      Offset(0f, h - bl),
    ),
    PrototypeContinuousCorner(
      Offset(0f, tl),
      Offset(0f, tl - d),
      Offset(tl - d, 0f),
      Offset(tl, 0f),
    ),
  )
}

internal fun prototypeContinuousPath(size: Size, radii: List<CornerRadius>): Path {
  val corners = prototypeContinuousCorners(size, radii)
  return Path().apply {
    val start = corners.last().end
    moveTo(start.x, start.y)
    for (corner in corners) {
      lineTo(corner.start.x, corner.start.y)
      cubicTo(
        corner.first.x,
        corner.first.y,
        corner.second.x,
        corner.second.y,
        corner.end.x,
        corner.end.y,
      )
    }
    close()
  }
}
