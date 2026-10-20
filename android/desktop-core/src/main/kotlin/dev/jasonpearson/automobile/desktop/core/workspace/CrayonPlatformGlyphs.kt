package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

internal fun DrawScope.drawLayers(tint: Color, st: Stroke, s: Float) {
  val w = s * 0.02f
  // two offset rounded cards
  line(p(s, 0.32f, 0.24f), p(s, 0.78f, 0.24f), -w, tint, st)
  line(p(s, 0.78f, 0.24f), p(s, 0.78f, 0.62f), -w, tint, st)
  line(p(s, 0.22f, 0.4f), p(s, 0.22f, 0.78f), w, tint, st)
  line(p(s, 0.22f, 0.78f), p(s, 0.68f, 0.78f), w, tint, st)
  line(p(s, 0.68f, 0.78f), p(s, 0.68f, 0.4f), -w, tint, st)
  line(p(s, 0.68f, 0.4f), p(s, 0.22f, 0.4f), -w, tint, st)
}

internal fun DrawScope.drawGlobe(tint: Color, st: Stroke, s: Float) {
  ring(Offset(s * 0.5f, s * 0.5f), Offset(s * 0.3f, s * 0.3f), tint, st)
  line(p(s, 0.2f, 0.5f), p(s, 0.8f, 0.5f), 0f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), 0f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), s * 0.16f, tint, st)
  line(p(s, 0.5f, 0.2f), p(s, 0.5f, 0.8f), -s * 0.16f, tint, st)
}

internal fun DrawScope.drawMore(tint: Color, st: Stroke, s: Float) {
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

internal fun DrawScope.drawUnlock(tint: Color, st: Stroke, s: Float) {
  // body
  line(p(s, 0.28f, 0.5f), p(s, 0.72f, 0.5f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.5f), p(s, 0.72f, 0.82f), -s * 0.015f, tint, st)
  line(p(s, 0.72f, 0.82f), p(s, 0.28f, 0.82f), s * 0.015f, tint, st)
  line(p(s, 0.28f, 0.82f), p(s, 0.28f, 0.5f), s * 0.015f, tint, st)
  // open shackle, swung to the left
  line(p(s, 0.34f, 0.5f), p(s, 0.34f, 0.34f), s * 0.02f, tint, st)
  line(p(s, 0.34f, 0.34f), p(s, 0.2f, 0.28f), s * 0.06f, tint, st)
}

internal fun DrawScope.drawAndroid(tint: Color, st: Stroke, s: Float) {
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

internal fun DrawScope.drawApple(tint: Color, st: Stroke, s: Float) {
  // two lobes forming an apple silhouette
  line(p(s, 0.5f, 0.34f), p(s, 0.28f, 0.5f), s * 0.1f, tint, st)
  line(p(s, 0.28f, 0.5f), p(s, 0.42f, 0.8f), s * 0.1f, tint, st)
  line(p(s, 0.42f, 0.8f), p(s, 0.5f, 0.72f), s * 0.03f, tint, st)
  line(p(s, 0.5f, 0.34f), p(s, 0.72f, 0.5f), -s * 0.1f, tint, st)
  line(p(s, 0.72f, 0.5f), p(s, 0.58f, 0.8f), -s * 0.1f, tint, st)
  line(p(s, 0.58f, 0.8f), p(s, 0.5f, 0.72f), -s * 0.03f, tint, st)
  line(p(s, 0.52f, 0.34f), p(s, 0.62f, 0.2f), s * 0.04f, tint, st) // leaf
}
