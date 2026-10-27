package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import dev.jasonpearson.automobile.protocol.PrototypeBackdrop
import dev.jasonpearson.automobile.protocol.PrototypeModeValue

/**
 * What a show with `window.backdrop` drew (`lastResult.backdrop`): a real blur or the tonal fill.
 */
enum class PrototypeBackdropMode(val wire: String) {
  BLUR("blur"),
  FALLBACK("fallback"),
}

/**
 * The resolved backdrop for one show (#15126). [radiusDp] is the blur radius for
 * [PrototypeBackdropMode.BLUR] and unused for the fallback; [tint] is the authored hex or role
 * colour, if any.
 */
data class PrototypeBackdropPlan(
  val mode: PrototypeBackdropMode,
  val radiusDp: Int,
  val tint: String?,
)

/** Whether the platform can blur what is behind a window right now; injected so tests are exact. */
fun interface PrototypeBackdropSupport {
  fun blurEnabled(): Boolean
}

/**
 * The Android blur decisions, shared by the window backdrop and by node-level `surface: "glass"`
 * (#15244, #15256): real blur needs API 31 (`RenderEffect` and window blur-behind) and, for a
 * window, cross-window blur not disabled by the device or battery saver. Below that, and for the
 * iOS-only `glass` material, the tonal fill is drawn instead.
 */
object PrototypeBackdrops {
  const val MIN_BLUR_SDK = 31

  /** Tonal fill alpha: `tint`, else the `surfaceContainer` role, drawn at this opacity. */
  const val TONAL_ALPHA = 0.85f

  /** Light tint over a real blur, so a tinted material still reads as tinted. */
  const val BLUR_TINT_ALPHA = 0.35f

  /** The role the tonal fill falls back to when no `tint` is authored. */
  const val DEFAULT_TONAL_ROLE = "surfaceContainer"

  /** Radius of each material when `blur` is absent, in dp. */
  fun materialRadiusDp(material: String): Int =
    when (material) {
      "ultraThin" -> 8
      "thin" -> 16
      "regular" -> 24
      "thick" -> 40
      else -> 24
    }

  fun blurSupported(sdkInt: Int, crossWindowBlurEnabled: Boolean): Boolean =
    sdkInt >= MIN_BLUR_SDK && crossWindowBlurEnabled

  fun plan(
    backdrop: PrototypeBackdrop,
    sdkInt: Int,
    crossWindowBlurEnabled: Boolean,
  ): PrototypeBackdropPlan {
    // `glass` is Liquid Glass: iOS 26+ only, so Android always draws its fallback.
    val blur = backdrop.material != "glass" && blurSupported(sdkInt, crossWindowBlurEnabled)
    return PrototypeBackdropPlan(
      if (blur) PrototypeBackdropMode.BLUR else PrototypeBackdropMode.FALLBACK,
      backdrop.blur ?: materialRadiusDp(backdrop.material),
      backdrop.tint,
    )
  }
}

/**
 * Blurs this composable's own rendering with `RenderEffect` on API 31+ and is a no-op below it, so
 * a caller that needs the fallback decides with [PrototypeBackdrops.blurSupported] (node-level
 * glass reuses this).
 */
fun Modifier.prototypeRenderBlur(radiusDp: Float, sdkInt: Int = Build.VERSION.SDK_INT): Modifier =
  if (sdkInt < PrototypeBackdrops.MIN_BLUR_SDK || radiusDp <= 0f) this
  else
    graphicsLayer {
      val radiusPx = radiusDp * density
      renderEffect = BlurEffect(radiusPx, radiusPx, TileMode.Decal)
    }

/**
 * Paints the backdrop's colour layer behind [content]: the tonal fill for the fallback, a light
 * tint over the window blur for [PrototypeBackdropMode.BLUR], nothing for an untinted blur.
 */
@Composable
@InternalAutoMobilePrototypeApi
fun PrototypeBackdropLayer(
  plan: PrototypeBackdropPlan?,
  content: @Composable () -> Unit,
) {
  if (plan == null) {
    content()
    return
  }
  val fallback = plan.mode == PrototypeBackdropMode.FALLBACK
  val role = plan.tint ?: if (fallback) PrototypeBackdrops.DEFAULT_TONAL_ROLE else null
  val color =
    role
      ?.let { prototypeThemedScrim(null, PrototypeModeValue.Single(it)) }
      ?.let { base ->
        base.copy(
          alpha =
            base.alpha *
              if (fallback) PrototypeBackdrops.TONAL_ALPHA else PrototypeBackdrops.BLUR_TINT_ALPHA,
        )
      }
  Box {
    if (color != null) Box(Modifier.matchParentSize().background(color))
    content()
  }
}
