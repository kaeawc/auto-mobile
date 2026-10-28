package dev.jasonpearson.automobile.design.system.components

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.CacheDrawScope
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sin

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
  // Cells per side of the repeating bitmap tile drawn below API 33.
  const val FALLBACK_TILE_CELLS = 32

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

/** CPU copy of the AGSL hash: the grain alpha for one cell, in `[0, MAX_ALPHA]`. */
internal fun crayonGrainAlpha(cellX: Int, cellY: Int, seed: Float): Float {
  val hashed =
    sin((cellX + seed) * CrayonGrainDefaults.HASH_X + (cellY + seed) * CrayonGrainDefaults.HASH_Y) *
      CrayonGrainDefaults.HASH_SCALE
  return (hashed - floor(hashed)).coerceIn(0f, 1f) * CrayonGrainDefaults.MAX_ALPHA
}

/** Side length in pixels of the fallback tile for a cell of [cellSizePx] pixels. */
internal fun crayonGrainTileSizePx(cellSizePx: Float): Int =
  ceil(CrayonGrainDefaults.FALLBACK_TILE_CELLS * cellSizePx).toInt().coerceAtLeast(1)

/**
 * Row-major ARGB pixels for a [tileSizePx] square of grain: black, with each pixel taking the alpha
 * of the [cellSizePx] cell it falls in, as the shader computes per fragment.
 */
internal fun crayonGrainTilePixels(tileSizePx: Int, cellSizePx: Float, seed: Float): IntArray =
  IntArray(tileSizePx * tileSizePx) { index ->
    val cellX = floor((index % tileSizePx) / cellSizePx).toInt()
    val cellY = floor((index / tileSizePx) / cellSizePx).toInt()
    (crayonGrainAlpha(cellX, cellY, seed) * 255f).roundToInt() shl 24
  }

/**
 * Overlays deterministic grain on content, clipped to [shape]. API 33+ draws it with an AGSL
 * RuntimeShader; API 24–32 draws the same hash from a repeating bitmap tile. The default clips to
 * bounds.
 */
fun Modifier.crayonGrain(
  shape: Shape = RectangleShape,
  seed: Float = CrayonGrainDefaults.SEED,
): Modifier = crayonGrain(shape, seed, Build.VERSION.SDK_INT)

@SuppressLint("NewApi") // The pure enum gate below guards the API-33-only implementation.
internal fun Modifier.crayonGrain(
  shape: Shape = RectangleShape,
  seed: Float = CrayonGrainDefaults.SEED,
  sdkInt: Int,
): Modifier =
  when (crayonGrainPath(sdkInt)) {
    CrayonGrainPath.SHADER -> grainOverlay(shape) { shaderGrainBrush(seed) }
    CrayonGrainPath.FALLBACK -> grainOverlay(shape) { tileGrainBrush(seed) }
  }

private fun Modifier.grainOverlay(shape: Shape, brush: CacheDrawScope.() -> Brush): Modifier =
  drawWithCache {
    val grain = brush()
    val clip =
      Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
    onDrawWithContent {
      drawContent()
      clipPath(clip) { drawRect(grain) }
    }
  }

@RequiresApi(CRAYON_GRAIN_MIN_SDK)
private fun CacheDrawScope.shaderGrainBrush(seed: Float): Brush {
  val shader = RuntimeShader(CrayonGrainDefaults.AGSL)
  shader.setFloatUniform("cellSize", CrayonGrainDefaults.CELL_SIZE_DP.dp.toPx())
  shader.setFloatUniform("seed", seed)
  return ShaderBrush(shader)
}

private fun CacheDrawScope.tileGrainBrush(seed: Float): Brush {
  val cellPx = CrayonGrainDefaults.CELL_SIZE_DP.dp.toPx()
  val tilePx = crayonGrainTileSizePx(cellPx)
  val pixels = crayonGrainTilePixels(tilePx, cellPx, seed)
  val tile = Bitmap.createBitmap(pixels, tilePx, tilePx, Bitmap.Config.ARGB_8888)
  return ShaderBrush(ImageShader(tile.asImageBitmap(), TileMode.Repeated, TileMode.Repeated))
}
