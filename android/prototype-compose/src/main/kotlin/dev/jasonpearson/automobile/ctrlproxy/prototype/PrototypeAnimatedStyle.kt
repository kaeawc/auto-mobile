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
import dev.jasonpearson.automobile.protocol.PrototypeCornerRadius
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypePadding
import dev.jasonpearson.automobile.protocol.PrototypeStyle

private const val DEFAULT_ANIMATE_MS = 300

/** Material 3's emphasized easing curve. */
private val EmphasizedEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/**
 * How a node's style changes move (#14208): with its `animate` duration and easing while motion is
 * on, and instantly otherwise (no `animate`, `motion: "none"`, or animator duration scale 0), so
 * `observe` and screenshots never see a value in flight. `spring` ignores the duration.
 */
@Composable
internal fun <T> prototypeStyleAnimation(
  animate: PrototypeAnimate?,
  effects: Boolean = false,
): AnimationSpec<T> {
  if (animate == null || !LocalPrototypeMotion.current) return snap()
  val duration = animate.durationMs ?: DEFAULT_ANIMATE_MS
  return when (animate.easing) {
    "spring" -> if (LocalPrototypeExpressive.current) prototypeExpressiveSpec(effects) else spring()
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
  if (!LocalPrototypeMotion.current) return target
  val alpha =
    animateFloatAsState(
      target,
      prototypeStyleAnimation(animate, effects = true),
      label = "prototypeAlpha",
    )
  ReportPrototypeMotion { alpha.value != target }
  return alpha.value
}

/** An authored colour, animated when the node declares `animate`; unspecified stays unspecified. */
@Composable
internal fun prototypeAnimatedColor(node: PrototypeRenderNode, color: Color): Color {
  if (!LocalPrototypeMotion.current || !color.isSpecified || node.source?.animate == null)
    return color
  val animated =
    animateColorAsState(
      color,
      prototypeStyleAnimation(node.source.animate, effects = true),
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
  if (animate == null || !LocalPrototypeMotion.current) {
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

/** Layout styles keep stable animation slots when styleWhen adds or removes numeric fields. */
@Composable
internal fun prototypeAnimatedLayout(node: PrototypeRenderNode): PrototypeStyle {
  val style = node.style.source
  val animate = node.source?.animate ?: return style
  if (!LocalPrototypeMotion.current) return style
  val authored = listOfNotNull(node.source.style) + node.source.styleWhen.orEmpty().map { it.style }
  @Composable
  fun number(target: Double): Double {
    if (LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL) return target
    val state =
      animateFloatAsState(
        target.toFloat(),
        prototypeStyleAnimation(animate),
        label = "prototypeLayout",
      )
    ReportPrototypeMotion { state.value != target.toFloat() }
    return state.value.toDouble().coerceAtLeast(0.0)
  }
  @Composable
  fun dimension(value: PrototypeDimension?): PrototypeDimension? =
    if (value is PrototypeDimension.Dp) PrototypeDimension.Dp(number(value.dp)) else value
  val corner =
    if (
      authored.any { it.cornerRadius != null } && style.cornerRadius !is PrototypeCornerRadius.Token
    ) {
      val value = style.cornerRadius
      val all = (value as? PrototypeCornerRadius.Dp)?.dp ?: 0.0
      val corners = value as? PrototypeCornerRadius.Corners
      PrototypeCornerRadius.Corners(
        topStart = number(corners?.topStart ?: all),
        topEnd = number(corners?.topEnd ?: all),
        bottomStart = number(corners?.bottomStart ?: all),
        bottomEnd = number(corners?.bottomEnd ?: all),
      )
    } else style.cornerRadius
  val borderWidth =
    if (authored.any { it.border != null }) number(style.border?.width ?: 0.0) else 0.0
  // Retain the authored border while its width returns to zero on removal.
  val border = style.border ?: authored.firstNotNullOfOrNull { it.border }
  val padding =
    if (authored.any { it.padding != null })
      PrototypePadding(
        top = number(style.padding?.top ?: 0.0),
        bottom = number(style.padding?.bottom ?: 0.0),
        start = number(style.padding?.start ?: 0.0),
        end = number(style.padding?.end ?: 0.0),
      )
    else style.padding
  return style.copy(
    width = dimension(style.width),
    height = dimension(style.height),
    cornerRadius = corner,
    elevation =
      if (authored.any { it.elevation != null }) number(style.elevation ?: 0.0)
      else style.elevation,
    border = border?.copy(width = borderWidth),
    padding = padding,
  )
}
