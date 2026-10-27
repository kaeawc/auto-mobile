package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.shadow.InnerShadowPainter
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeShadow

internal data class PrototypeShadowPixels(
  val sigma: Float,
  val spread: Float,
  val x: Float,
  val y: Float,
)

/** CSS-like blur: authored blur b has Gaussian sigma b/2, matching the iOS renderer. */
internal fun prototypeShadowPixels(layer: PrototypeShadow, density: Float) =
  PrototypeShadowPixels(
    layer.radius.toFloat() * density / 2f,
    (layer.spread ?: 0.0).toFloat() * density,
    (layer.offset?.x ?: 0.0).toFloat() * density,
    (layer.offset?.y ?: 0.0).toFloat() * density,
  )

/** Draw order, bottom-most first; the inner and outer groups preserve authored order. */
internal fun prototypeShadowLayers(layers: List<PrototypeShadow>?, inner: Boolean) =
  layers.orEmpty().filter { (it.inner == true) == inner }

// Compose forwards radius px to Android BlurMaskFilter. Skia converts that radius to sigma
// as radius * 0.57735 + 0.5. Invert it for CSS blur; subpixel sigmas use the minimum positive
// filter radius (Android cannot express sigma below 0.5 through BlurMaskFilter).
internal fun prototypeShadowRadius(blur: Float, density: Float): Float =
  if (blur <= 0f) 0f else ((blur * density / 2f - 0.5f) / 0.57735f).coerceAtLeast(0.001f) / density

internal fun prototypeResolvedShadow(layer: PrototypeShadow, color: Color, density: Float): Shadow {
  val pixels = prototypeShadowPixels(layer, density)
  return Shadow(
    radius = prototypeShadowRadius(layer.radius.toFloat(), density).dp,
    color = color,
    spread = (pixels.spread / density).dp,
    offset = DpOffset((pixels.x / density).dp, (pixels.y / density).dp),
  )
}

@Composable
internal fun Modifier.prototypeShadows(
  layers: List<PrototypeShadow>?,
  shape: Shape,
  inner: Boolean,
): Modifier {
  val density = androidx.compose.ui.platform.LocalDensity.current.density
  val shadows =
    prototypeShadowLayers(layers, inner).map { layer ->
      prototypeResolvedShadow(
        layer,
        prototypeThemedColor(null, layer.color) ?: Color.Transparent,
        density,
      )
    }
  if (shadows.isEmpty()) return this
  if (!inner) return shadows.fold(this) { modifier, shadow -> modifier.dropShadow(shape, shadow) }
  // Modifier.innerShadow paints BEFORE content in Compose 1.12.1. Use its native painter after
  // drawContent instead, so inner layers cover the border and preserve authored bottom-to-top
  // order.
  return drawWithCache {
    val painters = shadows.map { InnerShadowPainter(shape, it) }
    val clip =
      Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
    onDrawWithContent {
      drawContent()
      clipPath(clip) {
        for (painter in painters) with(painter) { draw(size) }
      }
    }
  }
}
