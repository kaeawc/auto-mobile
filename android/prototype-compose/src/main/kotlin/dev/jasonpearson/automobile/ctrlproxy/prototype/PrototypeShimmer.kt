package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription

private const val SHIMMER_MS = 1200
private const val SHIMMER_ALPHA = 0.35f

/**
 * Where the sweep's centre sits at [progress] (0..1): from one band-width before the start to one
 * after the end.
 */
internal fun prototypeShimmerCentre(progress: Float, width: Float, band: Float): Float =
  -band + progress * (width + 2 * band)

/**
 * Style `shimmer` (#14207): a highlight band sweeping across the node's background, on top of its
 * content. The node reads "Loading" to accessibility. With motion off (`motion: "none"` or animator
 * scale 0) no band is drawn, so screenshots and `observe` see the plain placeholder.
 */
@Composable
internal fun Modifier.prototypeShimmer(enabled: Boolean): Modifier {
  if (!enabled) return this
  val busy = semantics { stateDescription = "Loading" }
  if (
    !LocalPrototypeMotion.current ||
      LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL
  )
    return busy
  // An intentional infinite loop: counted as a loop, never as motion `observe` has to wait out.
  ReportPrototypeMotion(loop = true) { true }
  val transition = rememberInfiniteTransition(label = "prototypeShimmer")
  val progress by
    transition.animateFloat(
      0f,
      1f,
      infiniteRepeatable(tween(SHIMMER_MS, easing = LinearEasing), RepeatMode.Restart),
      label = "prototypeShimmerProgress",
    )
  val activity = LocalPrototypeMotionActivity.current
  return busy.drawWithContent {
    drawContent()
    // Retain the frame dependency while held so the band resumes at the deadline.
    val phase = progress
    if (activity?.captureHeld() == true) return@drawWithContent
    val band = size.width / 2
    val centre = prototypeShimmerCentre(phase, size.width, band)
    drawRect(
      Brush.linearGradient(
        listOf(Color.Transparent, Color.White.copy(alpha = SHIMMER_ALPHA), Color.Transparent),
        start = Offset(centre - band / 2, 0f),
        end = Offset(centre + band / 2, size.height),
      ),
    )
  }
}
