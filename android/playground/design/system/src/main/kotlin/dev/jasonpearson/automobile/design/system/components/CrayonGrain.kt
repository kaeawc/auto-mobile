package dev.jasonpearson.automobile.design.system.components

import android.annotation.SuppressLint
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.unit.dp

internal const val CRAYON_GRAIN_MIN_SDK = 33

internal enum class CrayonGrainPath {
  SHADER,
  FALLBACK,
}

internal fun crayonGrainPath(sdkInt: Int): CrayonGrainPath =
  if (sdkInt >= CRAYON_GRAIN_MIN_SDK) CrayonGrainPath.SHADER else CrayonGrainPath.FALLBACK

/** Shared grain tuning: static black flecks, at most 6% opacity, in 1.5dp cells. */
internal object CrayonGrainDefaults {
  const val SEED = 0f
  const val CELL_SIZE_DP = 1.5f
  const val MAX_ALPHA = 0.06f
  // Spatial hash coefficients; one sample per cell, with no time or animation input.
  const val HASH_X = 12.9898f
  const val HASH_Y = 78.233f
  const val HASH_SCALE = 43758.5453f

  val AGSL =
    """
    uniform float cellSize;
    uniform float seed;
    half4 main(float2 position) {
      float2 cell = floor(position / cellSize) + seed;
      float grain = fract(sin(dot(cell, float2($HASH_X, $HASH_Y))) * $HASH_SCALE);
      return half4(0.0, 0.0, 0.0, grain * $MAX_ALPHA);
    }
    """
      .trimIndent()
}

/**
 * Overlays deterministic grain on content, clipped to [shape]. API 24–32 returns the original
 * modifier: the existing Canvas/Path crayon outlines remain unchanged. The default clips to bounds.
 */
@SuppressLint("NewApi") // The pure enum gate below guards the API-33-only implementation.
fun Modifier.crayonGrain(
  shape: Shape = RectangleShape,
  seed: Float = CrayonGrainDefaults.SEED,
): Modifier =
  when (crayonGrainPath(Build.VERSION.SDK_INT)) {
    CrayonGrainPath.SHADER -> shaderCrayonGrain(shape, seed)
    CrayonGrainPath.FALLBACK -> this
  }

@RequiresApi(CRAYON_GRAIN_MIN_SDK)
private fun Modifier.shaderCrayonGrain(shape: Shape, seed: Float): Modifier = drawWithCache {
  val shader = RuntimeShader(CrayonGrainDefaults.AGSL)
  shader.setFloatUniform("cellSize", CrayonGrainDefaults.CELL_SIZE_DP.dp.toPx())
  shader.setFloatUniform("seed", seed)
  val brush = ShaderBrush(shader)
  val clip =
    Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
  onDrawWithContent {
    drawContent()
    clipPath(clip) { drawRect(brush) }
  }
}
