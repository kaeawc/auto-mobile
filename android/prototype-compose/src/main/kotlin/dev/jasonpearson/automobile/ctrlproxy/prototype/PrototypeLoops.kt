package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import dev.jasonpearson.automobile.protocol.PrototypeLoop
import kotlin.math.cos

/** Identity at each period boundary, including the end of a finite play. */
internal fun prototypeLoopScale(effect: String, progress: Float): Float =
  if (effect == "pulse") 1f + 0.04f * (1f - cos(2 * Math.PI * progress).toFloat()) else 1f

internal fun prototypeLoopRotation(effect: String, progress: Float): Float =
  if (effect == "spin") 360f * (progress % 1f) else 0f

/**
 * Attention transforms record a graphics layer, leaving layout, semantics and hit bounds intact.
 */
@Composable
internal fun Modifier.prototypeLoop(loop: PrototypeLoop?): Modifier {
  if (loop == null) return this
  val enabled =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL
  val count = loop.iterations?.count
  val progress =
    if (count == null) infiniteLoopProgress(loop, enabled)
    else finiteLoopProgress(loop, count, enabled)
  val activity = LocalPrototypeMotionActivity.current
  val layer = rememberGraphicsLayer()
  return drawWithContent {
    // Keep observing animation frames during a hold so its expiry redraws without a timer.
    val phase = progress.value
    val shown = if (!enabled || activity?.captureHeld() == true) 0f else phase
    layer.record { this@drawWithContent.drawContent() }
    layer.scaleX = prototypeLoopScale(loop.effect, shown)
    layer.scaleY = layer.scaleX
    layer.rotationZ = prototypeLoopRotation(loop.effect, shown)
    drawLayer(layer)
  }
}

/** Compose recognizes infinite transitions as intentional activity rather than an idle blocker. */
@Composable
private fun infiniteLoopProgress(loop: PrototypeLoop, enabled: Boolean): State<Float> {
  if (!enabled) return remember { mutableFloatStateOf(0f) }
  ReportPrototypeMotion(loop = true) { true }
  val transition = rememberInfiniteTransition(label = "prototypeLoop")
  return transition.animateFloat(
    0f,
    1f,
    infiniteRepeatable(tween(loop.periodMs, easing = LinearEasing)),
    label = "prototypeLoopProgress",
  )
}

@Composable
private fun finiteLoopProgress(loop: PrototypeLoop, count: Int, enabled: Boolean): State<Float> {
  val progress = remember(loop) { Animatable(0f) }
  LaunchedEffect(loop, enabled) {
    progress.snapTo(0f)
    if (enabled) {
      progress.animateTo(count.toFloat(), tween(loop.periodMs * count, easing = LinearEasing))
    }
  }
  ReportPrototypeMotion { enabled && progress.isRunning }
  return progress.asState()
}
