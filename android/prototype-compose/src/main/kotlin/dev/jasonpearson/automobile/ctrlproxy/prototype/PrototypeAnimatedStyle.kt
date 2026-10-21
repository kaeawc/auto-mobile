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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.isSpecified
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

/** A node's alpha, animated when the node declares `animate`. */
@Composable
internal fun prototypeAnimatedAlpha(node: PrototypeRenderNode): Float {
  val alpha by
    animateFloatAsState(
      (node.style.source.alpha ?: 1.0).toFloat(),
      prototypeStyleAnimation(node.source?.animate),
      label = "prototypeAlpha",
    )
  return alpha
}

/** An authored colour, animated when the node declares `animate`; unspecified stays unspecified. */
@Composable
internal fun prototypeAnimatedColor(node: PrototypeRenderNode, color: Color): Color {
  if (!color.isSpecified || node.source?.animate == null) return color
  val animated by
    animateColorAsState(
      color,
      prototypeStyleAnimation(node.source.animate),
      label = "prototypeColor",
    )
  return animated
}

/**
 * The node's draw-time `offset`, `scale` and `rotation`, animated when it declares `animate`. A
 * node with none of them and no `animate` gets no modifier. The layer reads the animated values in
 * the draw phase, so a running animation re-draws without recomposing.
 */
@Composable
internal fun Modifier.prototypeStyleTransform(node: PrototypeRenderNode): Modifier {
  val style = node.style.source
  val animate = node.source?.animate
  val transforms = style.scale != null || style.rotation != null
  if (animate == null && style.offset == null && !transforms) return this
  val spec = prototypeStyleAnimation<Float>(animate)
  val x by animateFloatAsState(style.offset?.x?.toFloat() ?: 0f, spec, label = "prototypeX")
  val y by animateFloatAsState(style.offset?.y?.toFloat() ?: 0f, spec, label = "prototypeY")
  val scale by animateFloatAsState(style.scale?.toFloat() ?: 1f, spec, label = "prototypeScale")
  val rotation by
    animateFloatAsState(style.rotation?.toFloat() ?: 0f, spec, label = "prototypeRotation")
  // A draw-time shift of the whole node (shadow, touch target and semantics included); siblings
  // keep the layout slot it would have had.
  val shifted = offset(x.dp, y.dp)
  // A node that only shifts keeps no extra layer, so its existing screenshots are unchanged.
  if (animate == null && !transforms) return shifted
  return shifted.graphicsLayer {
    scaleX = scale
    scaleY = scale
    rotationZ = rotation
  }
}
