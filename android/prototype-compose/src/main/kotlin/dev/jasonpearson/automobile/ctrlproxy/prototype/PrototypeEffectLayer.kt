package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asComposeRenderEffect

/** The per-frame inputs every distortion shares. */
internal class EffectFrame(val density: Float, val size: Size, val elapsedNanos: Long)

/** Shaders reused across frames, one per distortion slot (two waves must not share uniforms). */
internal class PrototypeEffectShaderCache {
  private val shaders = HashMap<String, Any>()

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  fun shader(slot: String, source: String): RuntimeShader =
    shaders.getOrPut(slot) { RuntimeShader(source) } as RuntimeShader
}

/**
 * The distortions chained in authored order (each later one sees the result of the earlier). Null
 * below API 31, or when none has anything to do (a 0 radius).
 */
internal fun prototypeLayerEffect(
  distortions: List<PrototypeEffect>,
  shaders: PrototypeEffectShaderCache,
  frame: EffectFrame,
): androidx.compose.ui.graphics.RenderEffect? {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
  return chainApi31(distortions, shaders, frame)
}

@RequiresApi(Build.VERSION_CODES.S)
private fun chainApi31(
  distortions: List<PrototypeEffect>,
  shaders: PrototypeEffectShaderCache,
  frame: EffectFrame,
): androidx.compose.ui.graphics.RenderEffect? {
  var chain: RenderEffect? = null
  distortions.forEachIndexed { index, effect ->
    val next = singleEffect(effect, "$index:${effect.type}", shaders, frame)
    if (next != null) chain = chain?.let { RenderEffect.createChainEffect(next, it) } ?: next
  }
  return chain?.asComposeRenderEffect()
}

@RequiresApi(Build.VERSION_CODES.S)
private fun singleEffect(
  effect: PrototypeEffect,
  slot: String,
  shaders: PrototypeEffectShaderCache,
  frame: EffectFrame,
): RenderEffect? {
  if (effect is PrototypeEffect.Blur) {
    val radius = effect.radiusDp * frame.density
    return if (radius > 0f) RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
    else null
  }
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
  val phase =
    prototypeEffectPhase(
      effect.phase,
      effect.animatePeriodMs.takeIf { effect.cycles },
      frame.elapsedNanos,
    )
  return shaderEffect(effect, slot, shaders, frame, phase)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun shaderEffect(
  effect: PrototypeEffect,
  slot: String,
  shaders: PrototypeEffectShaderCache,
  frame: EffectFrame,
  phase: Float,
): RenderEffect? {
  val density = frame.density
  val built =
    when (effect) {
      is PrototypeEffect.Pixelate ->
        shaders.shader(slot, PrototypeEffectShaders.PIXELATE).also {
          it.setFloatUniform("cell", (effect.cellDp * density).coerceAtLeast(1f))
        }
      is PrototypeEffect.ChromaticAberration ->
        shaders.shader(slot, PrototypeEffectShaders.CHROMATIC_ABERRATION).also {
          val (dx, dy) = prototypeEffectDirection(effect.angle)
          val offset = effect.offsetDp * density
          it.setFloatUniform("shift", dx * offset, dy * offset)
        }
      is PrototypeEffect.Wave ->
        shaders.shader(slot, PrototypeEffectShaders.WAVE).also {
          val (dx, dy) = prototypeEffectDirection(effect.angle)
          it.setFloatUniform("dir", dx, dy)
          it.setFloatUniform("amplitude", effect.amplitudeDp * density)
          it.setFloatUniform("wavelength", effect.wavelengthDp * density)
          it.setFloatUniform("phase", prototypeEffectRadians(phase))
        }
      is PrototypeEffect.Ripple ->
        shaders.shader(slot, PrototypeEffectShaders.RIPPLE).also {
          it.setFloatUniform(
            "centre",
            effect.centerX * frame.size.width,
            effect.centerY * frame.size.height,
          )
          it.setFloatUniform("amplitude", effect.amplitudeDp * density)
          it.setFloatUniform("wavelength", effect.wavelengthDp * density)
          it.setFloatUniform("phase", prototypeEffectRadians(phase))
        }
      else -> null
    } ?: return null
  return RenderEffect.createRuntimeShaderEffect(built, PrototypeEffectShaders.CONTENT)
}
