package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorizedFiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandIn
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Indication
import androidx.compose.foundation.LocalIndication
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.key
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import dev.jasonpearson.automobile.protocol.PrototypeMotionTokens

internal val LocalPrototypeExpressive = compositionLocalOf { false }

/**
 * Ripples are removed when motion is off; expressive springs come from [prototypeExpressiveSpec].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PrototypeMotionTheme(content: @Composable () -> Unit) {
  CompositionLocalProvider(
    LocalRippleConfiguration provides
      (if (LocalPrototypeMotion.current) LocalRippleConfiguration.current else null),
    content = content,
  )
}

/** Ripples follow the motion switch for the whole shared coordinate space. */
@Composable
internal fun PrototypeMotionSharedRoot(root: PrototypeRenderNode, content: @Composable () -> Unit) {
  PrototypeMotionTheme { PrototypeSharedRoot(root, content) }
}

@Composable
internal fun <T> prototypeExpressiveSpec(effects: Boolean = false): FiniteAnimationSpec<T> =
  if (!LocalPrototypeMotion.current) snap()
  else prototypeTokenSpec("expressive", if (effects) "effects" else "spatial")

/** Explicit specs keep the standard transition functions unchanged. */
@Composable
internal fun prototypeExpressiveEnter(
  type: String?,
  rtl: Boolean,
  delayMs: Int = 0,
): EnterTransition {
  val spatial = prototypeExpressiveSpec<IntSize>().prototypeEnterDelay(delayMs)
  val offset = prototypeExpressiveSpec<IntOffset>().prototypeEnterDelay(delayMs)
  val effects = prototypeExpressiveSpec<Float>(effects = true).prototypeEnterDelay(delayMs)
  return when (type) {
    "none" -> EnterTransition.None
    "fade",
    "blurReplace" -> fadeIn(effects)
    "expand" -> expandIn(spatial)
    "slide" -> slideInVertically(offset) + fadeIn(effects)
    "slideStart",
    "slideEnd" -> slideInHorizontally(offset) { prototypeSlideOffset(type, it, rtl) }
    "scale" ->
      scaleIn(prototypeExpressiveSpec<Float>().prototypeEnterDelay(delayMs)) + fadeIn(effects)
    else -> fadeIn(effects) + expandIn(spatial)
  }
}

@Composable
internal fun prototypeExpressiveExit(type: String?, rtl: Boolean): ExitTransition {
  val spatial = prototypeExpressiveSpec<IntSize>()
  val offset = prototypeExpressiveSpec<IntOffset>()
  val effects = prototypeExpressiveSpec<Float>(effects = true)
  return when (type) {
    "none" -> ExitTransition.None
    "fade",
    "blurReplace" -> fadeOut(effects)
    "expand" -> shrinkOut(spatial)
    "slide" -> slideOutVertically(offset) + fadeOut(effects)
    "slideStart",
    "slideEnd" -> slideOutHorizontally(offset) { prototypeSlideOffset(type, it, rtl) }
    "scale" -> scaleOut(prototypeExpressiveSpec()) + fadeOut(effects)
    else -> fadeOut(effects) + shrinkOut(spatial)
  }
}

/** No indication is installed on authored clickable nodes when motion is disabled. */
@Composable
internal fun prototypeIndication(motionEnabled: Boolean): Indication? =
  if (motionEnabled) LocalIndication.current else null

/** Material controls hide their internal specs; re-create at the final state when off. */
@Composable
internal fun PrototypeInstantControl(value: Any, content: @Composable () -> Unit) {
  key(if (LocalPrototypeMotion.current) Unit else value) { content() }
}

/** Holds [source] for [delayMs] before it starts, keeping visibility's finite-spec contract. */
internal fun <T> FiniteAnimationSpec<T>.prototypeEnterDelay(delayMs: Int): FiniteAnimationSpec<T> =
  if (delayMs == 0) this else PrototypeDelayedSpring(this, delayMs)

private data class PrototypeDelayedSpring<T>(val source: FiniteAnimationSpec<T>, val delayMs: Int) :
  FiniteAnimationSpec<T> {
  override fun <V : AnimationVector> vectorize(
    converter: TwoWayConverter<T, V>,
  ): VectorizedFiniteAnimationSpec<V> {
    val vector = source.vectorize(converter)
    val delayNanos = delayMs * 1_000_000L
    return object : VectorizedFiniteAnimationSpec<V> {
      override fun getDurationNanos(initialValue: V, targetValue: V, initialVelocity: V): Long =
        delayNanos + vector.getDurationNanos(initialValue, targetValue, initialVelocity)

      override fun getValueFromNanos(
        playTimeNanos: Long,
        initialValue: V,
        targetValue: V,
        initialVelocity: V,
      ): V =
        vector.getValueFromNanos(
          (playTimeNanos - delayNanos).coerceAtLeast(0),
          initialValue,
          targetValue,
          initialVelocity,
        )

      override fun getVelocityFromNanos(
        playTimeNanos: Long,
        initialValue: V,
        targetValue: V,
        initialVelocity: V,
      ): V =
        if (playTimeNanos < delayNanos) initialVelocity
        else
          vector.getVelocityFromNanos(
            playTimeNanos - delayNanos,
            initialValue,
            targetValue,
            initialVelocity,
          )
    }
  }
}

/** Pure conversion; both authored tempo and legacy spring easing use the same contract values. */
internal fun <T> prototypeTokenSpec(
  scheme: String,
  role: String,
  tempo: String = "default",
): FiniteAnimationSpec<T> {
  val token = PrototypeMotionTokens.token(scheme, role, tempo)
  return spring(dampingRatio = token.dampingRatio.toFloat(), stiffness = token.stiffness.toFloat())
}
