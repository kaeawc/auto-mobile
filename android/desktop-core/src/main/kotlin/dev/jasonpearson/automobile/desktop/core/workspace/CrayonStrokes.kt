package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.hypot

// --- drawing helpers -------------------------------------------------------------------------

internal fun p(s: Float, x: Float, y: Float) = Offset(x * s, y * s)

/**
 * A quadratic curve from [from] to [to] pushed [bow] perpendicular to its midpoint (hand-drawn).
 */
private fun bowed(from: Offset, to: Offset, bow: Float): Path {
  val dx = to.x - from.x
  val dy = to.y - from.y
  val len = hypot(dx, dy).coerceAtLeast(0.0001f)
  val nx = -dy / len
  val ny = dx / len
  val ctrl = Offset((from.x + to.x) / 2f + nx * bow, (from.y + to.y) / 2f + ny * bow)
  return Path().apply {
    moveTo(from.x, from.y)
    quadraticTo(ctrl.x, ctrl.y, to.x, to.y)
  }
}

internal fun DrawScope.line(from: Offset, to: Offset, bow: Float, tint: Color, st: Stroke) {
  drawPath(bowed(from, to, bow), tint, style = st)
}

/** A closed, slightly-wobbly ellipse from four bowed quarter-arcs, centered at [cx],[cy]. */
private fun oval(cx: Float, cy: Float, rx: Float, ry: Float, bow: Float): Path {
  val left = Offset(cx - rx, cy)
  val top = Offset(cx, cy - ry)
  val right = Offset(cx + rx, cy)
  val bottom = Offset(cx, cy + ry)
  return Path().apply {
    addPath(bowed(top, right, -bow))
    addPath(bowed(right, bottom, -bow))
    addPath(bowed(bottom, left, -bow))
    addPath(bowed(left, top, -bow))
  }
}

internal fun DrawScope.ring(center: Offset, radius: Offset, tint: Color, st: Stroke) {
  drawPath(
    oval(center.x, center.y, radius.x, radius.y, (radius.x + radius.y) * 0.06f),
    tint,
    style = st,
  )
}
