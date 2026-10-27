package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer

internal fun prototypeImageColorMatrix(saturation: Float = 1f): ColorMatrix =
  ColorMatrix().apply { setToSaturation(saturation) }

internal fun prototypeImageColorFilter(saturation: Double?): ColorFilter =
  ColorFilter.colorMatrix(prototypeImageColorMatrix((saturation ?: 1.0).toFloat()))

internal fun prototypeImageTintFilter(tint: Color): ColorFilter =
  ColorFilter.tint(tint, BlendMode.Modulate)

/** The image saturates first; a separate tint layer preserves its intermediate channel clamp. */
internal fun Modifier.prototypeImageTint(tint: Color?): Modifier =
  if (tint == null) this
  else
    graphicsLayer {
      compositingStrategy = CompositingStrategy.Offscreen
      colorFilter = prototypeImageTintFilter(tint)
    }
