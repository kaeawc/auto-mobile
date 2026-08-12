package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.hypot

/**
 * The app's hand-drawn crayon/marker icon set — outline only, no fill. Every glyph is authored as a
 * [Canvas] vector drawing (no raster assets) from gently *bowed* strokes (a line pushed off its
 * midpoint) with round caps, so shapes read as marker-drawn rather than geometric. Bow directions
 * are fixed, so a glyph looks identical frame to frame. Replaces the emoji glyphs across the
 * workspace; [CrayonIcon] renders one at any size/tint.
 */
enum class CrayonGlyph {
  Back,
  Home,
  Recent,
  Power,
  PointerTap, // Input mode
  Inspect, // magnifier
  Rotate,
  Camera, // screenshot
  Layers, // snapshot
  Globe, // locale / network
  More, // overflow dots
  Unlock,
  Android,
  Apple,
  Compass, // navigation
  Document, // logs
  Database, // storage
  Flask, // test
  Burst, // failures
  Bolt, // performance
  Close, // ✕
  Shrink, // collapse pane
  Diff, // open tool on all devices
}

/** The crayon glyph for each device-navigation button. */
fun DeviceButton.crayon(): CrayonGlyph =
  when (this) {
    DeviceButton.Home -> CrayonGlyph.Home
    DeviceButton.Back -> CrayonGlyph.Back
    DeviceButton.Recent -> CrayonGlyph.Recent
    DeviceButton.Power -> CrayonGlyph.Power
  }

/** The crayon glyph for each emulator control. */
fun EmulatorControl.crayon(): CrayonGlyph =
  when (this) {
    EmulatorControl.Rotate -> CrayonGlyph.Rotate
    EmulatorControl.Screenshot -> CrayonGlyph.Camera
    EmulatorControl.Snapshot -> CrayonGlyph.Layers
    EmulatorControl.Locale -> CrayonGlyph.Globe
    EmulatorControl.More -> CrayonGlyph.More
    EmulatorControl.Unlock -> CrayonGlyph.Unlock
  }

/** The crayon glyph for each facet tool. */
fun Tool.crayon(): CrayonGlyph =
  when (this) {
    Tool.Navigation -> CrayonGlyph.Compass
    Tool.Logs -> CrayonGlyph.Document
    Tool.Storage -> CrayonGlyph.Database
    Tool.Network -> CrayonGlyph.Globe
    Tool.Test -> CrayonGlyph.Flask
    Tool.Failures -> CrayonGlyph.Burst
    Tool.Performance -> CrayonGlyph.Bolt
  }

/** The crayon glyph for each device platform. */
fun Platform.crayon(): CrayonGlyph =
  when (this) {
    Platform.Android -> CrayonGlyph.Android
    Platform.Ios -> CrayonGlyph.Apple
  }

@Composable
fun CrayonIcon(glyph: CrayonGlyph, tint: Color, modifier: Modifier = Modifier) {
  Canvas(modifier) {
    val s = size.minDimension
    val st = Stroke(width = s * 0.085f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    when (glyph) {
      CrayonGlyph.Back -> drawBack(tint, st, s)
      CrayonGlyph.Home -> drawHome(tint, st, s)
      CrayonGlyph.Recent -> drawRecent(tint, st, s)
      CrayonGlyph.Power -> drawPower(tint, st, s)
      CrayonGlyph.PointerTap -> drawPointerTap(tint, st, s)
      CrayonGlyph.Inspect -> drawInspect(tint, st, s)
      CrayonGlyph.Rotate -> drawRotate(tint, st, s)
      CrayonGlyph.Camera -> drawCamera(tint, st, s)
      CrayonGlyph.Layers -> drawLayers(tint, st, s)
      CrayonGlyph.Globe -> drawGlobe(tint, st, s)
      CrayonGlyph.More -> drawMore(tint, st, s)
      CrayonGlyph.Unlock -> drawUnlock(tint, st, s)
      CrayonGlyph.Android -> drawAndroid(tint, st, s)
      CrayonGlyph.Apple -> drawApple(tint, st, s)
      CrayonGlyph.Compass -> drawCompass(tint, st, s)
      CrayonGlyph.Document -> drawDocument(tint, st, s)
      CrayonGlyph.Database -> drawDatabase(tint, st, s)
      CrayonGlyph.Flask -> drawFlask(tint, st, s)
      CrayonGlyph.Burst -> drawBurst(tint, st, s)
      CrayonGlyph.Bolt -> drawBolt(tint, st, s)
      CrayonGlyph.Close -> drawClose(tint, st, s)
      CrayonGlyph.Shrink -> drawShrink(tint, st, s)
      CrayonGlyph.Diff -> drawDiff(tint, st, s)
    }
  }
}

// --- drawing helpers -------------------------------------------------------------------------

private fun p(s: Float, x: Float, y: Float) = Offset(x * s, y * s)

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

private fun DrawScope.line(from: Offset, to: Offset, bow: Float, tint: Color, st: Stroke) {
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

private fun DrawScope.ring(cx: Float, cy: Float, rx: Float, ry: Float, tint: Color, st: Stroke) {
  drawPath(oval(cx, cy, rx, ry, (rx + ry) * 0.06f), tint, style = st)
}

// --- glyphs ----------------------------------------------------------------------------------

private fun DrawScope.drawBack(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.03f
  line(p(s, 0.82f, 0.5f), p(s, 0.24f, 0.5f), w, tint, st)
  line(p(s, 0.24f, 0.5f), p(s, 0.46f, 0.29f), w * 0.6f, tint, st)
  line(p(s, 0.24f, 0.5f), p(s, 0.46f, 0.71f), -w * 0.6f, tint, st)
}

private fun DrawScope.drawHome(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.028f
  line(p(s, 0.5f, 0.15f), p(s, 0.15f, 0.5f), w, tint, st)
  line(p(s, 0.5f, 0.15f), p(s, 0.85f, 0.5f), -w, tint, st)
  line(p(s, 0.25f, 0.46f), p(s, 0.25f, 0.83f), w * 0.7f, tint, st)
  line(p(s, 0.75f, 0.46f), p(s, 0.75f, 0.83f), -w * 0.7f, tint, st)
  line(p(s, 0.25f, 0.83f), p(s, 0.75f, 0.83f), w * 0.6f, tint, st)
  line(p(s, 0.44f, 0.83f), p(s, 0.44f, 0.62f), -w * 0.4f, tint, st)
  line(p(s, 0.44f, 0.62f), p(s, 0.56f, 0.62f), w * 0.4f, tint, st)
  line(p(s, 0.56f, 0.62f), p(s, 0.56f, 0.83f), w * 0.4f, tint, st)
}

private fun DrawScope.drawRecent(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.035f
  line(p(s, 0.26f, 0.24f), p(s, 0.74f, 0.24f), -w, tint, st)
  line(p(s, 0.74f, 0.24f), p(s, 0.74f, 0.76f), -w, tint, st)
  line(p(s, 0.74f, 0.76f), p(s, 0.26f, 0.76f), w, tint, st)
  line(p(s, 0.26f, 0.76f), p(s, 0.26f, 0.24f), w, tint, st)
}

private fun DrawScope.drawPower(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.5f, 0.18f), p(s, 0.5f, 0.5f), 0f, tint, st)
  val w = s * 0.07f
  line(p(s, 0.34f, 0.3f), p(s, 0.28f, 0.6f), w, tint, st)
  line(p(s, 0.28f, 0.6f), p(s, 0.5f, 0.82f), w, tint, st)
  line(p(s, 0.5f, 0.82f), p(s, 0.72f, 0.6f), w, tint, st)
  line(p(s, 0.72f, 0.6f), p(s, 0.66f, 0.3f), w, tint, st)
}

private fun DrawScope.drawPointerTap(tint: Color, st: Stroke, s: Float) {
  // A pointer/cursor arrow with two little tap ripples.
  line(p(s, 0.34f, 0.24f), p(s, 0.34f, 0.66f), s * 0.02f, tint, st)
  line(p(s, 0.34f, 0.24f), p(s, 0.62f, 0.52f), s * 0.02f, tint, st)
  line(p(s, 0.62f, 0.52f), p(s, 0.44f, 0.55f), s * 0.01f, tint, st)
  line(p(s, 0.44f, 0.55f), p(s, 0.34f, 0.66f), s * 0.01f, tint, st)
  line(p(s, 0.68f, 0.24f), p(s, 0.78f, 0.2f), s * 0.02f, tint, st)
  line(p(s, 0.7f, 0.36f), p(s, 0.82f, 0.34f), s * 0.02f, tint, st)
}

private fun DrawScope.drawInspect(tint: Color, st: Stroke, s: Float) {
  ring(s * 0.44f, s * 0.44f, s * 0.22f, s * 0.22f, tint, st)
  line(p(s, 0.6f, 0.6f), p(s, 0.82f, 0.82f), s * 0.02f, tint, st)
}

private fun DrawScope.drawRotate(tint: Color, st: Stroke, s: Float) {
  // A ~3/4 circular arrow.
  line(p(s, 0.72f, 0.3f), p(s, 0.3f, 0.28f), s * 0.16f, tint, st)
  line(p(s, 0.3f, 0.28f), p(s, 0.28f, 0.72f), s * 0.16f, tint, st)
  line(p(s, 0.28f, 0.72f), p(s, 0.6f, 0.78f), s * 0.14f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.58f, 0.2f), s * 0.02f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.82f, 0.18f), s * 0.02f, tint, st)
}

private fun DrawScope.drawCamera(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.2f, 0.34f), p(s, 0.8f, 0.34f), -s * 0.02f, tint, st)
  line(p(s, 0.8f, 0.34f), p(s, 0.8f, 0.74f), -s * 0.02f, tint, st)
  line(p(s, 0.8f, 0.74f), p(s, 0.2f, 0.74f), s * 0.02f, tint, st)
  line(p(s, 0.2f, 0.74f), p(s, 0.2f, 0.34f), s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.34f), p(s, 0.46f, 0.24f), s * 0.01f, tint, st)
  line(p(s, 0.46f, 0.24f), p(s, 0.54f, 0.24f), s * 0.01f, tint, st)
  line(p(s, 0.54f, 0.24f), p(s, 0.62f, 0.34f), s * 0.01f, tint, st)
  ring(s * 0.5f, s * 0.54f, s * 0.13f, s * 0.13f, tint, st)
}

private fun DrawScope.drawLayers(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.02f
  // two offset rounded cards
  line(p(s, 0.32f, 0.24f), p(s, 0.78f, 0.24f), -w, tint, st)
  line(p(s, 0.78f, 0.24f), p(s, 0.78f, 0.62f), -w, tint, st)
  line(p(s, 0.22f, 0.4f), p(s, 0.22f, 0.78f), w, tint, st)
  line(p(s, 0.22f, 0.78f), p(s, 0.68f, 0.78f), w, tint, st)
  line(p(s, 0.68f, 0.78f), p(s, 0.68f, 0.4f), -w, tint, st)
  line(p(s, 0.68f, 0.4f), p(s, 0.22f, 0.4f), -w, tint, st)
}

private fun DrawScope.drawGlobe(tint: Color, st: Stroke, s: Float) {
  ring(s * 0.5f, s * 0.5f, s * 0.3f, s * 0.3f, tint, st)
  line(p(s, 0.2f, 0.5f), p(s, 0.8f, 0.5f), 0f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), 0f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), s * 0.16f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), -s * 0.16f, tint, st)
}

private fun DrawScope.drawMore(tint: Color, st: Stroke, s: Float) {
  val dot = Stroke(width = s * 0.14f, cap = StrokeCap.Round)
  drawPath(
    Path().apply {
      moveTo(s * 0.28f, s * 0.5f)
      lineTo(s * 0.28f, s * 0.5f)
    },
    tint,
    style = dot,
  )
  drawPath(
    Path().apply {
      moveTo(s * 0.5f, s * 0.5f)
      lineTo(s * 0.5f, s * 0.5f)
    },
    tint,
    style = dot,
  )
  drawPath(
    Path().apply {
      moveTo(s * 0.72f, s * 0.5f)
      lineTo(s * 0.72f, s * 0.5f)
    },
    tint,
    style = dot,
  )
}

private fun DrawScope.drawUnlock(tint: Color, st: Stroke, s: Float) {
  // body
  line(p(s, 0.28f, 0.5f), p(s, 0.72f, 0.5f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.5f), p(s, 0.72f, 0.82f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.82f), p(s, 0.28f, 0.82f), s * 0.015f, tint, st)
  line(p(s, 0.28f, 0.82f), p(s, 0.28f, 0.5f), s * 0.015f, tint, st)
  // open shackle, swung to the left
  line(p(s, 0.34f, 0.5f), p(s, 0.34f, 0.34f), s * 0.02f, tint, st)
  line(p(s, 0.34f, 0.34f), p(s, 0.2f, 0.28f), s * 0.06f, tint, st)
}

private fun DrawScope.drawAndroid(tint: Color, st: Stroke, s: Float) {
  // dome head + antennae + eyes
  line(p(s, 0.28f, 0.56f), p(s, 0.28f, 0.44f), s * 0.02f, tint, st)
  line(p(s, 0.28f, 0.44f), p(s, 0.72f, 0.44f), -s * 0.18f, tint, st) // dome
  line(p(s, 0.72f, 0.44f), p(s, 0.72f, 0.56f), s * 0.02f, tint, st)
  line(p(s, 0.28f, 0.56f), p(s, 0.72f, 0.56f), 0f, tint, st)
  line(p(s, 0.34f, 0.34f), p(s, 0.4f, 0.42f), s * 0.005f, tint, st) // left antenna
  line(p(s, 0.66f, 0.34f), p(s, 0.6f, 0.42f), s * 0.005f, tint, st) // right antenna
  val eye = Stroke(width = s * 0.07f, cap = StrokeCap.Round)
  drawPath(
    Path().apply {
      moveTo(s * 0.42f, s * 0.49f)
      lineTo(s * 0.42f, s * 0.49f)
    },
    tint,
    style = eye,
  )
  drawPath(
    Path().apply {
      moveTo(s * 0.58f, s * 0.49f)
      lineTo(s * 0.58f, s * 0.49f)
    },
    tint,
    style = eye,
  )
  // body
  line(p(s, 0.3f, 0.58f), p(s, 0.3f, 0.76f), s * 0.015f, tint, st)
  line(p(s, 0.3f, 0.76f), p(s, 0.7f, 0.76f), s * 0.015f, tint, st)
  line(p(s, 0.7f, 0.76f), p(s, 0.7f, 0.58f), -s * 0.015f, tint, st)
}

private fun DrawScope.drawApple(tint: Color, st: Stroke, s: Float) {
  // two lobes forming an apple silhouette
  line(p(s, 0.5f, 0.34f), p(s, 0.28f, 0.5f), s * 0.1f, tint, st)
  line(p(s, 0.28f, 0.5f), p(s, 0.42f, 0.8f), s * 0.1f, tint, st)
  line(p(s, 0.42f, 0.8f), p(s, 0.5f, 0.72f), s * 0.03f, tint, st)
  line(p(s, 0.5f, 0.34f), p(s, 0.72f, 0.5f), -s * 0.1f, tint, st)
  line(p(s, 0.72f, 0.5f), p(s, 0.58f, 0.8f), -s * 0.1f, tint, st)
  line(p(s, 0.58f, 0.8f), p(s, 0.5f, 0.72f), -s * 0.03f, tint, st)
  line(p(s, 0.52f, 0.34f), p(s, 0.62f, 0.2f), s * 0.04f, tint, st) // leaf
}

private fun DrawScope.drawCompass(tint: Color, st: Stroke, s: Float) {
  ring(s * 0.5f, s * 0.5f, s * 0.3f, s * 0.3f, tint, st)
  // needle
  line(p(s, 0.5f, 0.5f), p(s, 0.62f, 0.36f), s * 0.02f, tint, st)
  line(p(s, 0.62f, 0.36f), p(s, 0.42f, 0.44f), s * 0.01f, tint, st)
  line(p(s, 0.5f, 0.5f), p(s, 0.38f, 0.64f), s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.64f), p(s, 0.58f, 0.56f), s * 0.01f, tint, st)
}

private fun DrawScope.drawDocument(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.3f, 0.2f), p(s, 0.62f, 0.2f), s * 0.01f, tint, st)
  line(p(s, 0.62f, 0.2f), p(s, 0.72f, 0.32f), s * 0.01f, tint, st) // folded corner
  line(p(s, 0.72f, 0.32f), p(s, 0.72f, 0.8f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.8f), p(s, 0.3f, 0.8f), s * 0.015f, tint, st)
  line(p(s, 0.3f, 0.8f), p(s, 0.3f, 0.2f), s * 0.015f, tint, st)
  line(p(s, 0.4f, 0.44f), p(s, 0.62f, 0.44f), 0f, tint, st) // text lines
  line(p(s, 0.4f, 0.56f), p(s, 0.62f, 0.56f), 0f, tint, st)
  line(p(s, 0.4f, 0.68f), p(s, 0.56f, 0.68f), 0f, tint, st)
}

private fun DrawScope.drawDatabase(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.28f, 0.3f), p(s, 0.72f, 0.3f), -s * 0.08f, tint, st) // top ellipse (front)
  line(p(s, 0.72f, 0.3f), p(s, 0.28f, 0.3f), -s * 0.08f, tint, st) // top ellipse (back)
  line(p(s, 0.28f, 0.3f), p(s, 0.28f, 0.7f), s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.72f, 0.7f), -s * 0.015f, tint, st)
  line(p(s, 0.28f, 0.5f), p(s, 0.72f, 0.5f), -s * 0.06f, tint, st) // middle band
  line(p(s, 0.28f, 0.7f), p(s, 0.72f, 0.7f), -s * 0.06f, tint, st) // bottom
}

private fun DrawScope.drawFlask(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.42f, 0.2f), p(s, 0.42f, 0.44f), s * 0.005f, tint, st)
  line(p(s, 0.58f, 0.2f), p(s, 0.58f, 0.44f), -s * 0.005f, tint, st)
  line(p(s, 0.42f, 0.44f), p(s, 0.26f, 0.76f), s * 0.02f, tint, st)
  line(p(s, 0.58f, 0.44f), p(s, 0.74f, 0.76f), -s * 0.02f, tint, st)
  line(p(s, 0.26f, 0.76f), p(s, 0.74f, 0.76f), -s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.2f), p(s, 0.62f, 0.2f), 0f, tint, st) // lip
  line(p(s, 0.34f, 0.64f), p(s, 0.66f, 0.64f), 0f, tint, st) // liquid line
}

private fun DrawScope.drawBurst(tint: Color, st: Stroke, s: Float) {
  val c = Offset(s * 0.5f, s * 0.5f)
  val spikes = listOf(0.0, 0.6, 1.2, 1.9, 2.5, 3.1, 3.8, 4.4, 5.0, 5.7)
  spikes.forEach { a ->
    val far =
      Offset(
        (c.x + kotlin.math.cos(a) * s * 0.3f).toFloat(),
        (c.y + kotlin.math.sin(a) * s * 0.3f).toFloat(),
      )
    line(c, far, 0f, tint, st)
  }
}

private fun DrawScope.drawClose(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.28f, 0.28f), p(s, 0.72f, 0.72f), s * 0.02f, tint, st)
  line(p(s, 0.72f, 0.28f), p(s, 0.28f, 0.72f), -s * 0.02f, tint, st)
}

private fun DrawScope.drawShrink(tint: Color, st: Stroke, s: Float) {
  // Two corner brackets pulling inward.
  line(p(s, 0.22f, 0.38f), p(s, 0.22f, 0.22f), s * 0.01f, tint, st)
  line(p(s, 0.22f, 0.22f), p(s, 0.38f, 0.22f), s * 0.01f, tint, st)
  line(p(s, 0.22f, 0.22f), p(s, 0.42f, 0.42f), s * 0.02f, tint, st)
  line(p(s, 0.78f, 0.62f), p(s, 0.78f, 0.78f), s * 0.01f, tint, st)
  line(p(s, 0.78f, 0.78f), p(s, 0.62f, 0.78f), s * 0.01f, tint, st)
  line(p(s, 0.78f, 0.78f), p(s, 0.58f, 0.58f), s * 0.02f, tint, st)
}

private fun DrawScope.drawDiff(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.025f
  // back card
  line(p(s, 0.4f, 0.24f), p(s, 0.76f, 0.24f), -w, tint, st)
  line(p(s, 0.76f, 0.24f), p(s, 0.76f, 0.6f), -w, tint, st)
  // front card
  line(p(s, 0.24f, 0.4f), p(s, 0.24f, 0.76f), w, tint, st)
  line(p(s, 0.24f, 0.76f), p(s, 0.6f, 0.76f), w, tint, st)
  line(p(s, 0.6f, 0.76f), p(s, 0.6f, 0.4f), -w, tint, st)
  line(p(s, 0.6f, 0.4f), p(s, 0.24f, 0.4f), -w, tint, st)
}

private fun DrawScope.drawBolt(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.58f, 0.18f), p(s, 0.36f, 0.52f), s * 0.015f, tint, st)
  line(p(s, 0.36f, 0.52f), p(s, 0.52f, 0.52f), 0f, tint, st)
  line(p(s, 0.52f, 0.52f), p(s, 0.44f, 0.84f), -s * 0.015f, tint, st)
  line(p(s, 0.44f, 0.84f), p(s, 0.66f, 0.46f), s * 0.02f, tint, st)
  line(p(s, 0.66f, 0.46f), p(s, 0.5f, 0.46f), 0f, tint, st)
  line(p(s, 0.5f, 0.46f), p(s, 0.58f, 0.18f), s * 0.015f, tint, st)
}
