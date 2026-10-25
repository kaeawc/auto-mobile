package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandIn
import androidx.compose.animation.fadeIn
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeChoreographyRules
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeRowNode

/**
 * Each `visibleWhen` child's stagger wait in layout order (#15247): `ms` times its rank among the
 * children with `visibleWhen`, 0 for every other child and for a container without `stagger`.
 */
internal fun prototypeStaggerDelays(
  container: PrototypeNode,
  children: List<PrototypeNode>,
): List<Int> {
  val stagger =
    when (container) {
      is PrototypeBoxNode -> container.stagger
      is PrototypeRowNode -> container.stagger
      is PrototypeColumnNode -> container.stagger
      else -> null
    }
  val staggered = children.indices.filter { children[it].visibleWhen != null }
  if (stagger == null || staggered.isEmpty()) return List(children.size) { 0 }
  val waits = PrototypeChoreographyRules.delays(staggered.size, stagger.ms, stagger.order) { 0 }
  return List(children.size) { index ->
    staggered.indexOf(index).let { rank -> if (rank < 0) 0 else waits[rank] }
  }
}

/** Length of the enter animations when a delay is set; unset enters keep Compose's springs. */
internal const val DELAYED_ENTER_MS = 300

/** How far a `blurReplace` node is blurred while it is entering or leaving. */
private val BLUR_REPLACE_RADIUS = 12.dp

/**
 * `blurReplace` (#15247): a blur that clears as the node enters and returns as it leaves. The blur
 * modifier does nothing below Android 12, which leaves the fade alone there. [delayMs] holds the
 * blur until the delayed fade starts.
 */
@Composable
internal fun Modifier.prototypeBlurReplace(
  scope: AnimatedVisibilityScope,
  type: String?,
  delayMs: Int,
): Modifier {
  if (type != "blurReplace") return this
  val radius by
    scope.transition.animateDp(
      transitionSpec = {
        tween(
          DELAYED_ENTER_MS,
          delayMillis = if (targetState == EnterExitState.Visible) delayMs else 0,
        )
      },
      label = "prototypeBlurReplace",
    ) { state ->
      if (state == EnterExitState.Visible) 0.dp else BLUR_REPLACE_RADIUS
    }
  return blur(radius)
}

/** The `visibleWhen` enter transition for a node's `transition`; absent keeps fade + expand. */
internal fun prototypeEnterTransition(
  transition: String?,
  rtl: Boolean = false,
  delayMs: Int = 0,
): EnterTransition =
  if (delayMs > 0) delayedEnterTransition(transition, rtl, delayMs)
  else enterTransition(transition, rtl)

/** An enter that waits [delayMs] first: the same shapes as [enterTransition] on fixed tweens. */
private fun delayedEnterTransition(
  transition: String?,
  rtl: Boolean,
  delayMs: Int,
): EnterTransition {
  val fade = tween<Float>(DELAYED_ENTER_MS, delayMillis = delayMs)
  val offset = tween<IntOffset>(DELAYED_ENTER_MS, delayMillis = delayMs)
  val size = tween<IntSize>(DELAYED_ENTER_MS, delayMillis = delayMs)
  return when (transition) {
    "none" -> EnterTransition.None
    "fade",
    "blurReplace" -> fadeIn(fade)
    "expand" -> expandIn(size)
    "slide" -> slideInVertically(offset) + fadeIn(fade)
    "slideStart",
    "slideEnd" -> slideInHorizontally(offset) { prototypeSlideOffset(transition, it, rtl) }
    "scale" -> scaleIn(fade) + fadeIn(fade)
    else -> fadeIn(fade) + expandIn(size)
  }
}

private fun enterTransition(transition: String?, rtl: Boolean): EnterTransition =
  when (transition) {
    "none" -> EnterTransition.None
    "fade",
    "blurReplace" -> fadeIn()
    "expand" -> expandIn()
    "slide" -> slideInVertically() + fadeIn()
    "slideStart",
    "slideEnd" -> slideInHorizontally { prototypeSlideOffset(transition, it, rtl) }
    "scale" -> scaleIn() + fadeIn()
    else -> fadeIn() + expandIn()
  }
