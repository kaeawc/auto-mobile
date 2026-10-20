package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.animateFloat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics

/**
 * The fade of the `visibleWhen` ancestors an anchored node was authored under, as one multiplier
 * (#10869). An anchored node is drawn in the window-level anchor layer, away from those ancestors,
 * so it reads their exit transition's progress from here instead of running a transition of its
 * own: it then fades exactly with them, and stays composed exactly as long as they do.
 */
internal val LocalPrototypeAnchorFade = compositionLocalOf<() -> Float> { { 1f } }

/** The anchored node's current fade, for tests: 1 while its ancestors are shown, 0 once gone. */
internal val PrototypeAnchorFadeKey = SemanticsPropertyKey<Float>("PrototypeAnchorFade")

/**
 * Provides this `visibleWhen` node's own enter/exit progress, times its ancestors', to the anchored
 * nodes below it. A `none` transition removes the node at once, so it contributes no fade.
 */
@Composable
internal fun AnimatedVisibilityScope.ProvideAnchorFade(
  none: Boolean,
  content: @Composable () -> Unit,
) {
  val outer = LocalPrototypeAnchorFade.current
  // Not animated for `none`: a child animation of the transition would hold the node on screen.
  val own =
    if (none) null
    else
      transition.animateFloat(label = "prototypeAnchorFade") {
        if (it == EnterExitState.Visible) 1f else 0f
      }
  // The layer drops the anchored node a recomposition after this leaves the composition; until
  // then the node must not be drawn once, opaque, after its ancestors are gone.
  val present = remember { mutableStateOf(true) }
  DisposableEffect(present) { onDispose { present.value = false } }
  val fade: () -> Float =
    remember(outer, own) {
      { if (present.value) outer() * (own?.value ?: 1f) else 0f }
    }
  CompositionLocalProvider(LocalPrototypeAnchorFade provides fade, content = content)
}

/**
 * Applies [fade] to the anchored node's draw without an offscreen layer. The default compositing of
 * a translucent layer clips to the layer's bounds, and an anchored node is drawn away from the
 * zero-size slot those bounds describe, so a fade through `alpha` or `AnimatedVisibility` clipped
 * the node away on its first translucent frame (#10869).
 */
internal fun Modifier.anchorFade(fade: () -> Float): Modifier = graphicsLayer {
  alpha = fade()
  compositingStrategy = CompositingStrategy.ModulateAlpha
}
  .semantics { this[PrototypeAnchorFadeKey] = fade() }
