package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

internal fun DrawScope.drawBack(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.03f
  line(p(s, 0.82f, 0.5f), p(s, 0.24f, 0.5f), w, tint, st)
  line(p(s, 0.24f, 0.5f), p(s, 0.46f, 0.29f), w * 0.6f, tint, st)
  line(p(s, 0.24f, 0.5f), p(s, 0.46f, 0.71f), -w * 0.6f, tint, st)
}

internal fun DrawScope.drawHome(tint: Color, st: Stroke, s: Float) {
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

internal fun DrawScope.drawRecent(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.035f
  line(p(s, 0.26f, 0.24f), p(s, 0.74f, 0.24f), -w, tint, st)
  line(p(s, 0.74f, 0.24f), p(s, 0.74f, 0.76f), -w, tint, st)
  line(p(s, 0.74f, 0.76f), p(s, 0.26f, 0.76f), w, tint, st)
  line(p(s, 0.26f, 0.76f), p(s, 0.26f, 0.24f), w, tint, st)
}

internal fun DrawScope.drawPower(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.5f, 0.18f), p(s, 0.5f, 0.5f), 0f, tint, st)
  val w = s * 0.07f
  line(p(s, 0.34f, 0.3f), p(s, 0.28f, 0.6f), w, tint, st)
  line(p(s, 0.28f, 0.6f), p(s, 0.5f, 0.82f), w, tint, st)
  line(p(s, 0.5f, 0.82f), p(s, 0.72f, 0.6f), w, tint, st)
  line(p(s, 0.72f, 0.6f), p(s, 0.66f, 0.3f), w, tint, st)
}

internal fun DrawScope.drawPointerTap(tint: Color, st: Stroke, s: Float) {
  // A pointer/cursor arrow with two little tap ripples.
  line(p(s, 0.34f, 0.24f), p(s, 0.34f, 0.66f), s * 0.02f, tint, st)
  line(p(s, 0.34f, 0.24f), p(s, 0.62f, 0.52f), s * 0.02f, tint, st)
  line(p(s, 0.62f, 0.52f), p(s, 0.44f, 0.55f), s * 0.01f, tint, st)
  line(p(s, 0.44f, 0.55f), p(s, 0.34f, 0.66f), s * 0.01f, tint, st)
  line(p(s, 0.68f, 0.24f), p(s, 0.78f, 0.2f), s * 0.02f, tint, st)
  line(p(s, 0.7f, 0.36f), p(s, 0.82f, 0.34f), s * 0.02f, tint, st)
}

internal fun DrawScope.drawInspect(tint: Color, st: Stroke, s: Float) {
  ring(Offset(s * 0.44f, s * 0.44f), Offset(s * 0.22f, s * 0.22f), tint, st)
  line(p(s, 0.6f, 0.6f), p(s, 0.82f, 0.82f), s * 0.02f, tint, st)
}

internal fun DrawScope.drawRotate(tint: Color, st: Stroke, s: Float) {
  // A ~3/4 circular arrow.
  line(p(s, 0.72f, 0.3f), p(s, 0.3f, 0.28f), s * 0.16f, tint, st)
  line(p(s, 0.3f, 0.28f), p(s, 0.28f, 0.72f), s * 0.16f, tint, st)
  line(p(s, 0.28f, 0.72f), p(s, 0.6f, 0.78f), s * 0.14f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.58f, 0.2f), s * 0.02f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.82f, 0.18f), s * 0.02f, tint, st)
}

internal fun DrawScope.drawCamera(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.2f, 0.34f), p(s, 0.8f, 0.34f), -s * 0.02f, tint, st)
  line(p(s, 0.8f, 0.34f), p(s, 0.8f, 0.74f), -s * 0.02f, tint, st)
  line(p(s, 0.8f, 0.74f), p(s, 0.2f, 0.74f), s * 0.02f, tint, st)
  line(p(s, 0.2f, 0.74f), p(s, 0.2f, 0.34f), s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.34f), p(s, 0.46f, 0.24f), s * 0.01f, tint, st)
  line(p(s, 0.46f, 0.24f), p(s, 0.54f, 0.24f), s * 0.01f, tint, st)
  line(p(s, 0.54f, 0.24f), p(s, 0.62f, 0.34f), s * 0.01f, tint, st)
  ring(Offset(s * 0.5f, s * 0.54f), Offset(s * 0.13f, s * 0.13f), tint, st)
}
