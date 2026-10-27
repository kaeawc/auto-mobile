package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeAnimate

private const val DEFAULT_ANIMATE_MS = 300

/** Material 3's emphasized easing curve. */
private val EmphasizedEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/**
 * How a node's style changes move (#14208): with its `animate` duration and easing while motion is
 * on, and instantly otherwise (no `animate`, `motion: "none"`, or animator duration scale 0), so
 * `observe` and screenshots never see a value in flight. `spring` ignores the duration.
 */
@Composable
internal fun <T> prototypeStyleAnimation(animate: PrototypeAnimate?): AnimationSpec<T> {
  if (animate == null || !LocalPrototypeMotion.current) return snap()
  val duration = animate.durationMs ?: DEFAULT_ANIMATE_MS
  return when (animate.easing) {
    "spring" -> spring()
    "linear" -> tween(duration, easing = LinearEasing)
    "emphasized" -> tween(duration, easing = EmphasizedEasing)
    else -> tween(duration, easing = FastOutSlowInEasing)
  }
}

/**
 * A node's alpha, animated when the node declares `animate`. Without it the authored value is used
 * directly: an animation state that snaps would still cost a second recomposition per change.
 */
@Composable
internal fun prototypeAnimatedAlpha(node: PrototypeRenderNode): Float {
  val target = (node.style.source.alpha ?: 1.0).toFloat()
  val animate = node.source?.animate ?: return target
  val alpha =
    animateFloatAsState(target, prototypeStyleAnimation(animate), label = "prototypeAlpha")
  ReportPrototypeMotion { alpha.value != target }
  return alpha.value
}

/** An authored colour, animated when the node declares `animate`; unspecified stays unspecified. */
@Composable
internal fun prototypeAnimatedColor(node: PrototypeRenderNode, color: Color): Color {
  if (!color.isSpecified || node.source?.animate == null) return color
  val animated =
    animateColorAsState(
      color,
      prototypeStyleAnimation(node.source.animate),
      label = "prototypeColor",
    )
  ReportPrototypeMotion { animated.value != color }
  return animated.value
}

/**
 * The node's draw-time `offset`, `scale` and `rotation`, animated when it declares `animate`. A
 * node with none of them and no `animate` gets no modifier, and one that only shifts gets no layer,
 * so existing screenshots are unchanged. A shift moves the whole node (shadow, touch target and
 * semantics included); siblings keep the layout slot it would have had.
 */
@Composable
internal fun Modifier.prototypeStyleTransform(node: PrototypeRenderNode): Modifier {
  val style = node.style.source
  val animate = node.source?.animate
  val x = style.offset?.x?.toFloat() ?: 0f
  val y = style.offset?.y?.toFloat() ?: 0f
  val scale = style.scale?.toFloat() ?: 1f
  val rotation = style.rotation?.toFloat() ?: 0f
  if (animate == null) {
    val shifted = if (style.offset != null) offset(x.dp, y.dp) else this
    return if (style.scale == null && style.rotation == null) shifted
    else shifted.graphicsLayer(scaleX = scale, scaleY = scale, rotationZ = rotation)
  }
  return animatedTransform(animate, x, y, scale, rotation)
}

/** The animated transform reads its values in the placement and draw phases, not in composition. */
@Composable
private fun Modifier.animatedTransform(
  animate: PrototypeAnimate,
  x: Float,
  y: Float,
  scale: Float,
  rotation: Float,
): Modifier {
  val spec =
    if (LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL) snap<Float>()
    else prototypeStyleAnimation<Float>(animate)
  val animatedX = animateFloatAsState(x, spec, label = "prototypeX")
  val animatedY = animateFloatAsState(y, spec, label = "prototypeY")
  val animatedScale = animateFloatAsState(scale, spec, label = "prototypeScale")
  val animatedRotation = animateFloatAsState(rotation, spec, label = "prototypeRotation")
  ReportPrototypeMotion {
    animatedX.value != x ||
      animatedY.value != y ||
      animatedScale.value != scale ||
      animatedRotation.value != rotation
  }
  return offset { IntOffset(animatedX.value.dp.roundToPx(), animatedY.value.dp.roundToPx()) }
    .graphicsLayer {
      scaleX = animatedScale.value
      scaleY = animatedScale.value
      rotationZ = animatedRotation.value
    }
}
