package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

internal fun DrawScope.drawCompass(tint: Color, st: Stroke, s: Float) {
  ring(Offset(s * 0.5f, s * 0.5f), Offset(s * 0.3f, s * 0.3f), tint, st)
  // needle
  line(p(s, 0.5f, 0.5f), p(s, 0.62f, 0.36f), s * 0.02f, tint, st)
  line(p(s, 0.62f, 0.36f), p(s, 0.42f, 0.44f), s * 0.01f, tint, st)
  line(p(s, 0.5f, 0.5f), p(s, 0.38f, 0.64f), s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.64f), p(s, 0.58f, 0.56f), s * 0.01f, tint, st)
}

internal fun DrawScope.drawDocument(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.3f, 0.2f), p(s, 0.62f, 0.2f), s * 0.01f, tint, st)
  line(p(s, 0.62f, 0.2f), p(s, 0.72f, 0.32f), s * 0.01f, tint, st) // folded corner
  line(p(s, 0.72f, 0.32f), p(s, 0.72f, 0.8f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.8f), p(s, 0.3f, 0.8f), s * 0.015f, tint, st)
  line(p(s, 0.3f, 0.8f), p(s, 0.3f, 0.2f), s * 0.015f, tint, st)
  line(p(s, 0.4f, 0.44f), p(s, 0.62f, 0.44f), 0f, tint, st) // text lines
  line(p(s, 0.4f, 0.56f), p(s, 0.62f, 0.56f), 0f, tint, st)
  line(p(s, 0.4f, 0.68f), p(s, 0.56f, 0.68f), 0f, tint, st)
}

internal fun DrawScope.drawDatabase(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.28f, 0.3f), p(s, 0.72f, 0.3f), -s * 0.08f, tint, st) // top ellipse (front)
  line(p(s, 0.72f, 0.3f), p(s, 0.28f, 0.3f), -s * 0.08f, tint, st) // top ellipse (back)
  line(p(s, 0.28f, 0.3f), p(s, 0.28f, 0.7f), s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.3f), p(s, 0.72f, 0.7f), -s * 0.015f, tint, st)
  line(p(s, 0.28f, 0.5f), p(s, 0.72f, 0.5f), -s * 0.06f, tint, st) // middle band
  line(p(s, 0.28f, 0.7f), p(s, 0.72f, 0.7f), -s * 0.06f, tint, st) // bottom
}

internal fun DrawScope.drawFlask(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.42f, 0.2f), p(s, 0.42f, 0.44f), s * 0.005f, tint, st)
  line(p(s, 0.58f, 0.2f), p(s, 0.58f, 0.44f), -s * 0.005f, tint, st)
  line(p(s, 0.42f, 0.44f), p(s, 0.26f, 0.76f), s * 0.02f, tint, st)
  line(p(s, 0.58f, 0.44f), p(s, 0.74f, 0.76f), -s * 0.02f, tint, st)
  line(p(s, 0.26f, 0.76f), p(s, 0.74f, 0.76f), -s * 0.02f, tint, st)
  line(p(s, 0.38f, 0.2f), p(s, 0.62f, 0.2f), 0f, tint, st) // lip
  line(p(s, 0.34f, 0.64f), p(s, 0.66f, 0.64f), 0f, tint, st) // liquid line
}

internal fun DrawScope.drawBurst(tint: Color, st: Stroke, s: Float) {
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

internal fun DrawScope.drawClose(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.28f, 0.28f), p(s, 0.72f, 0.72f), s * 0.02f, tint, st)
  line(p(s, 0.72f, 0.28f), p(s, 0.28f, 0.72f), -s * 0.02f, tint, st)
}

internal fun DrawScope.drawShrink(tint: Color, st: Stroke, s: Float) {
  // Two corner brackets pulling inward.
  line(p(s, 0.22f, 0.38f), p(s, 0.22f, 0.22f), s * 0.01f, tint, st)
  line(p(s, 0.22f, 0.22f), p(s, 0.38f, 0.22f), s * 0.01f, tint, st)
  line(p(s, 0.22f, 0.22f), p(s, 0.42f, 0.42f), s * 0.02f, tint, st)
  line(p(s, 0.78f, 0.62f), p(s, 0.78f, 0.78f), s * 0.01f, tint, st)
  line(p(s, 0.78f, 0.78f), p(s, 0.62f, 0.78f), s * 0.01f, tint, st)
  line(p(s, 0.78f, 0.78f), p(s, 0.58f, 0.58f), s * 0.02f, tint, st)
}

internal fun DrawScope.drawDiff(tint: Color, st: Stroke, s: Float) {
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

internal fun DrawScope.drawBolt(tint: Color, st: Stroke, s: Float) {
  line(p(s, 0.58f, 0.18f), p(s, 0.36f, 0.52f), s * 0.015f, tint, st)
  line(p(s, 0.36f, 0.52f), p(s, 0.52f, 0.52f), 0f, tint, st)
  line(p(s, 0.52f, 0.52f), p(s, 0.44f, 0.84f), -s * 0.015f, tint, st)
  line(p(s, 0.44f, 0.84f), p(s, 0.66f, 0.46f), s * 0.02f, tint, st)
  line(p(s, 0.66f, 0.46f), p(s, 0.5f, 0.46f), 0f, tint, st)
  line(p(s, 0.5f, 0.46f), p(s, 0.58f, 0.18f), s * 0.015f, tint, st)
}
