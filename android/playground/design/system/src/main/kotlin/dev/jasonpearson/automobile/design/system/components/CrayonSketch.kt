package dev.jasonpearson.automobile.design.system.components

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

// ---------------------------------------------------------------------------
// Crayon sketch — a hand-drawn, marker-style outline for the design system.
// The perimeter geometry is a pure, deterministic (seeded) jitter of a rounded
// rectangle, kept in `Offset` space so it is host-testable (no android.graphics
// Path) and never flakes. The Modifier turns it into a double-stroked border.
// All primitives are minSdk-24 safe (Canvas/Path/Brush) — no RuntimeShader.
// ---------------------------------------------------------------------------

/** Deterministic hash noise in [-1, 1) from a seed and index. */
private fun sketchNoise(seed: Long, i: Int): Float {
  var h = seed xor (i.toLong() * -0x61c8864680b583ebL) // * 0x9E3779B97F4A7C15
  h = (h xor (h ushr 33)) * -0x7ee3623a03d3c9e9L // 0xFF51AFD7ED558CCD
  h = (h xor (h ushr 33)) * -0x3b314601e57a13adL // 0xC4CEB9FE1A85EC53
  h = h xor (h ushr 33)
  val u = (h ushr 11).toDouble() / (1L shl 53).toDouble() // [0, 1)
  return (u * 2.0 - 1.0).toFloat()
}

/**
 * Base rounded-rectangle perimeter, sampled clockwise from the top edge and closed (the last point
 * repeats the first base position). Every point lies within the `[0,width] x [0,height]` box.
 */
private fun roundedRectPerimeter(
  width: Float,
  height: Float,
  corner: Float,
  segmentsPerEdge: Int,
): List<Offset> {
  val r = corner.coerceIn(0f, min(width, height) / 2f)
  // At least one straight-edge sample: a zero count skips every edge point and a
  // negative one is an empty range that drops the edge entirely.
  val segs = segmentsPerEdge.coerceAtLeast(1)
  val pts = ArrayList<Offset>()
  fun edge(x0: Float, y0: Float, x1: Float, y1: Float) {
    for (s in 0 until segs) {
      val t = s.toFloat() / segs
      pts.add(Offset(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    }
  }
  // Half-open like `edge`: emit the arc's start but not its end, so the arc's last
  // point never duplicates the following edge's first point. A duplicated seam point
  // gets its own jitter and shows as a knot; the dropped corner point is supplied by
  // the next segment's start (and the final one by the closing append below).
  fun arc(cx: Float, cy: Float, startDeg: Float) {
    val steps = 3
    for (s in 0 until steps) {
      val ang = (startDeg + 90f * s / steps) * PI.toFloat() / 180f
      pts.add(Offset(cx + r * cos(ang), cy + r * sin(ang)))
    }
  }
  edge(r, 0f, width - r, 0f)
  arc(width - r, r, -90f)
  edge(width, r, width, height - r)
  arc(width - r, height - r, 0f)
  edge(width - r, height, r, height)
  arc(r, height - r, 90f)
  edge(0f, height - r, 0f, r)
  arc(r, r, 180f)
  pts.add(pts.first()) // close the loop
  return pts
}

/**
 * The hand-drawn crayon outline of a rounded rectangle: a deterministic, seeded jitter of the
 * perimeter. Same `seed` -> identical points; jitter magnitude is bounded by `roughness`, so points
 * stay within `[-roughness, size+roughness]`.
 */
fun crayonOutlineOffsets(
  width: Float,
  height: Float,
  cornerRadius: Float,
  seed: Long,
  roughness: Float,
  segmentsPerEdge: Int = 6,
): List<Offset> {
  val base = roundedRectPerimeter(width, height, cornerRadius, segmentsPerEdge)
  val jittered = base.mapIndexed { i, p ->
    Offset(
      p.x + sketchNoise(seed, i * 2) * roughness,
      p.y + sketchNoise(seed, i * 2 + 1) * roughness,
    )
  }
  // The last base point duplicates the first; close the loop *exactly* by reusing
  // the first jittered point rather than letting it drift by its own noise.
  return jittered.dropLast(1) + jittered.first()
}

/**
 * A hand-drawn 1-D crayon line: a deterministic, seeded perpendicular jitter of a straight baseline
 * from `(0, 0)` to `(length, 0)`. Same [seed] -> identical points. The endpoints stay anchored on
 * the baseline (`y == 0`) so a divider meets both edges cleanly, while interior points wobble in
 * `y` within `[-roughness, roughness]`. `x` is monotonic across `segments + 1` samples. Pure
 * `Offset` maths (host-testable). Used for the top-app-bar / bottom-nav divider strokes — a full
 * [crayonBorder] would read as a box, so nav surfaces get a single sketchy line instead.
 */
fun crayonLinePoints(
  length: Float,
  seed: Long,
  roughness: Float,
  segments: Int = 12,
): List<Offset> {
  // Zero/negative segments would drop every sample or crash the range; clamp to a single span.
  val segs = segments.coerceAtLeast(1)
  return (0..segs).map { i ->
    val x = length * i / segs
    // Anchor the endpoints on the baseline so the divider meets both component edges.
    val jitterY = if (i == 0 || i == segs) 0f else sketchNoise(seed, i) * roughness
    Offset(x, jitterY)
  }
}

private fun List<Offset>.toPath(): Path =
  Path().apply {
    forEachIndexed { i, o -> if (i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) }
    close()
  }

/**
 * Draws a hand-drawn crayon border on top of the content: two slightly different jittered strokes
 * give the doubled-up marker feel. Deterministic per [seed].
 */
fun Modifier.crayonBorder(
  color: Color,
  width: Dp = 2.5.dp,
  cornerRadius: Dp = 18.dp,
  seed: Long = 0L,
  roughness: Dp = 2.5.dp,
): Modifier = drawWithCache {
  val rough = roughness.toPx()
  val corner = cornerRadius.toPx()
  val strokePx = width.toPx()
  // Sample ~1 point per 26dp of the longest edge so the wobble density is
  // consistent whether the component is a small chip or a wide text field.
  val spacing = 26.dp.toPx()
  val seg = (maxOf(size.width, size.height) / spacing).toInt().coerceIn(6, 48)
  // Two offset passes read as a doubled-up marker line.
  val main = crayonOutlineOffsets(size.width, size.height, corner, seed, rough, seg).toPath()
  val echo =
    crayonOutlineOffsets(size.width, size.height, corner, seed + 101L, rough * 1.2f, seg).toPath()
  val solid = Stroke(width = strokePx, cap = StrokeCap.Round, join = StrokeJoin.Round)
  val faint = Stroke(width = strokePx * 0.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
  onDrawWithContent {
    drawContent()
    // Attenuate the caller's alpha rather than replacing it, so a translucent (or
    // Transparent) border color stays translucent.
    drawPath(echo, color = color.copy(alpha = color.alpha * 0.55f), style = faint)
    drawPath(main, color = color, style = solid)
  }
}

/**
 * Draws a single hand-drawn crayon line along the top or bottom edge of the content — the nav
 * surfaces' answer to [crayonBorder]. A full wobbly box would fight a top app bar / bottom nav, so
 * they get one sketchy divider stroke instead (built from [crayonLinePoints]). Deterministic per
 * [seed]; minSdk-24 safe.
 */
fun Modifier.crayonHorizontalEdge(
  color: Color,
  atBottom: Boolean,
  thickness: Dp = 2.5.dp,
  seed: Long = 0L,
  roughness: Dp = 2.dp,
): Modifier = drawWithCache {
  val rough = roughness.toPx()
  val strokePx = thickness.toPx()
  // Sample ~1 point per 24dp so the wobble density is consistent across bar widths.
  val spacing = 24.dp.toPx()
  val seg = (size.width / spacing).toInt().coerceIn(8, 64)
  // Inset by the stroke so the whole rounded line stays inside the component bounds.
  val baseY = if (atBottom) size.height - strokePx else strokePx
  val line =
    crayonLinePoints(size.width, seed, rough, seg).map { Offset(it.x, baseY + it.y) }.toPolyline()
  val stroke = Stroke(width = strokePx, cap = StrokeCap.Round, join = StrokeJoin.Round)
  onDrawWithContent {
    drawContent()
    drawPath(line, color = color, style = stroke)
  }
}

/** An open polyline (unlike [toPath], which closes the loop for a border). */
private fun List<Offset>.toPolyline(): Path =
  Path().apply { forEachIndexed { i, o -> if (i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) } }
