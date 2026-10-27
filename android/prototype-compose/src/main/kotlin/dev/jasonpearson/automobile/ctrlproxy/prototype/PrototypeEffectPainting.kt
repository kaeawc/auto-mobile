package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.toArgb
import kotlin.math.hypot

private const val SHIMMER_MAX_ALPHA = 0.5f
private const val SHIMMER_DEFAULT_ALPHA = 0.35f

internal fun ContentDrawScope.withShapeClip(shape: Shape, block: DrawScope.() -> Unit) {
  when (val outline = shape.createOutline(size, layoutDirection, this)) {
    is Outline.Rectangle -> clipRect { block() }
    is Outline.Rounded -> clipPath(Path().apply { addRoundRect(outline.roundRect) }) { block() }
    is Outline.Generic -> clipPath(outline.path) { block() }
  }
}

internal fun DrawScope.drawShimmer(
  effect: PrototypeEffect.Shimmer,
  palette: PrototypePalette,
  phase: Float,
) {
  val base =
    prototypeEffectColor(palette, effect.color) ?: Color.White.copy(alpha = SHIMMER_DEFAULT_ALPHA)
  val peak = base.copy(alpha = minOf(base.alpha, SHIMMER_MAX_ALPHA))
  val (from, to) = prototypeLinearGradientLine(effect.angle.toDouble(), size.width, size.height)
  // The band's centre travels from one half-width before the start to one half-width after the end.
  val half = effect.width / 2f
  val centre = -half + phase * (1f + effect.width)
  val stops =
    arrayOf(
      0f to Color.Transparent,
      (centre - half).coerceIn(0f, 1f) to Color.Transparent,
      centre.coerceIn(0f, 1f) to peak,
      (centre + half).coerceIn(0f, 1f) to Color.Transparent,
      1f to Color.Transparent,
    )
  drawRect(Brush.linearGradient(*stops, start = from, end = to))
}

internal fun DrawScope.drawGlow(effect: PrototypeEffect.Glow, palette: PrototypePalette) {
  val color = prototypeEffectColor(palette, effect.color) ?: return
  val radius = effect.radiusDp * density
  if (radius <= 0f || effect.intensity <= 0f) return
  val strong = color.copy(alpha = color.alpha * effect.intensity)
  val edge = Color.Transparent
  val w = size.width
  val h = size.height
  // Four inward fades, one per edge, so the glow hugs the border and never leaves the node.
  drawRect(
    Brush.verticalGradient(listOf(strong, edge), 0f, radius),
    size = Size(w, minOf(radius, h)),
  )
  drawRect(
    Brush.verticalGradient(listOf(edge, strong), h - radius, h),
    topLeft = Offset(0f, (h - radius).coerceAtLeast(0f)),
    size = Size(w, minOf(radius, h)),
  )
  drawRect(
    Brush.horizontalGradient(listOf(strong, edge), 0f, radius),
    size = Size(minOf(radius, w), h),
  )
  drawRect(
    Brush.horizontalGradient(listOf(edge, strong), w - radius, w),
    topLeft = Offset((w - radius).coerceAtLeast(0f), 0f),
    size = Size(minOf(radius, w), h),
  )
}

internal fun DrawScope.drawVignette(effect: PrototypeEffect.Vignette, palette: PrototypePalette) {
  val base = prototypeEffectColor(palette, effect.color) ?: Color.Black
  val reach = hypot(size.width, size.height) / 2f
  if (reach <= 0f || effect.intensity <= 0f) return
  val clear = effect.radius.coerceIn(0f, 1f)
  val edge = base.copy(alpha = base.alpha * effect.intensity)
  drawRect(
    Brush.radialGradient(
      clear to Color.Transparent,
      1f to edge,
      center = Offset(size.width / 2f, size.height / 2f),
      radius = reach,
    ),
  )
}

/** Holds the lazily created noise shader (API 33); a no-op holder below it. */
internal class NoiseHolder {
  var shader: Any? = null
}

internal class MeshHolder {
  var shader: Any? = null
}

internal fun DrawScope.drawNoise(effect: PrototypeEffect.Noise, holder: NoiseHolder) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
  drawNoiseApi33(effect, holder)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun DrawScope.drawNoiseApi33(effect: PrototypeEffect.Noise, holder: NoiseHolder) {
  val shader =
    (holder.shader as? RuntimeShader)
      ?: RuntimeShader(PrototypeEffectShaders.NOISE).also { holder.shader = it }
  val (seedX, seedY) = prototypeNoiseSeedOffset(effect.seed)
  shader.setFloatUniform("grain", effect.grainDp * density)
  shader.setFloatUniform("amount", effect.amount)
  shader.setFloatUniform("seed", seedX, seedY)
  shader.setFloatUniform("mono", if (effect.monochrome) 1f else 0f)
  drawRect(ShaderBrush(shader))
}

internal fun DrawScope.drawMesh(
  effect: PrototypeEffect.GradientMesh,
  palette: PrototypePalette,
  holder: MeshHolder,
) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
  drawMeshApi33(effect, palette, holder)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun DrawScope.drawMeshApi33(
  effect: PrototypeEffect.GradientMesh,
  palette: PrototypePalette,
  holder: MeshHolder,
) {
  val colors = effect.colors.map { prototypeEffectColor(palette, it) ?: Color.Transparent }
  val shader =
    (holder.shader as? RuntimeShader)
      ?: RuntimeShader(PrototypeEffectShaders.GRADIENT_MESH).also { holder.shader = it }
  shader.setFloatUniform("size", size.width, size.height)
  shader.setFloatUniform("softness", effect.softness)
  MESH_UNIFORMS.forEachIndexed { index, name ->
    shader.setColorUniform(name, colors[index].toArgb())
  }
  drawRect(ShaderBrush(shader))
}

private val MESH_UNIFORMS = listOf("topStart", "topEnd", "bottomStart", "bottomEnd")
