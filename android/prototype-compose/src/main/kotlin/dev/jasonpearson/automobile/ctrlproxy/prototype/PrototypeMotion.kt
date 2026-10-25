package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeChoreographyRules
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeFlowNode
import dev.jasonpearson.automobile.protocol.PrototypeGridNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeRowNode

/**
 * Whether prototype state changes (visibility, page) animate. Off by default so previews and direct
 * [PrototypeSpecContent] callers stay settled; [PrototypeRuntimeContent] turns it on from the spec.
 */
internal val LocalPrototypeMotion = compositionLocalOf { false }

/**
 * Animation is on unless the spec opts out (`motion: "none"`) or the system animator duration scale
 * is 0 (`settings put global animator_duration_scale 0`), which keeps screenshots settled.
 */
internal fun prototypeMotionEnabled(motion: String?, durationScale: Float): Boolean =
  motion != "none" && durationScale > 0f

/** Reads the system animator duration scale; 1 (the platform default) when unset. */
internal fun readAnimatorDurationScale(resolver: ContentResolver): Float =
  Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/**
 * The system animator duration scale as Compose state, kept current while the prototype is shown.
 * Automation commonly sets the scale to 0 after a prototype is already up; observing the setting
 * (rather than reading it once per spec) makes the very next state change instant, so `observe`
 * never captures an in-flight animation.
 */
@Composable
internal fun rememberAnimatorDurationScale(resolver: ContentResolver): State<Float> {
  val scale = remember(resolver) { mutableFloatStateOf(readAnimatorDurationScale(resolver)) }
  DisposableEffect(resolver) {
    val observer =
      object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          scale.floatValue = readAnimatorDurationScale(resolver)
        }
      }
    resolver.registerContentObserver(
      Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
      false,
      observer,
    )
    // A change between the first read and registration has no callback; re-read once.
    scale.floatValue = readAnimatorDurationScale(resolver)
    onDispose { resolver.unregisterContentObserver(observer) }
  }
  return scale
}

/**
 * The x a horizontal slide starts from (enter) or ends at (exit): off the start edge for
 * `slideStart`, off the end edge for `slideEnd`, mirrored in right-to-left layouts (#14208).
 */
internal fun prototypeSlideOffset(transition: String, width: Int, rtl: Boolean): Int {
  val fromStart = (transition == "slideStart") != rtl
  return if (fromStart) -width else width
}

/** Whether the enclosing layout runs right to left, so start and end slides mirror. */
@Composable
internal fun prototypeRtl(): Boolean = LocalLayoutDirection.current == LayoutDirection.Rtl

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
private const val DELAYED_ENTER_MS = 300

/** How far a `blurReplace` node is blurred while it is entering or leaving. */
private val BLUR_REPLACE_RADIUS = 12.dp

/**
 * `blurReplace` (#15247): a blur that clears as the node enters and returns as it leaves. The blur
 * modifier does nothing below Android 12, which leaves the fade alone there. [delayMs] holds the
 * blur until the delayed fade starts.
 */
@Composable
internal fun AnimatedVisibilityScope.prototypeBlurReplace(type: String?, delayMs: Int): Modifier {
  if (type != "blurReplace") return Modifier
  val radius by
    transition.animateDp(
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
  return Modifier.blur(radius)
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

/** The `visibleWhen` exit transition for a node's `transition`; absent keeps fade + shrink. */
internal fun prototypeExitTransition(transition: String?, rtl: Boolean = false): ExitTransition =
  when (transition) {
    "none" -> ExitTransition.None
    "fade",
    "blurReplace" -> fadeOut()
    "expand" -> shrinkOut()
    "slide" -> slideOutVertically() + fadeOut()
    "slideStart",
    "slideEnd" -> slideOutHorizontally { prototypeSlideOffset(transition, it, rtl) }
    "scale" -> scaleOut() + fadeOut()
    else -> fadeOut() + shrinkOut()
  }

/** Whether this container owns size animation for repeat or child visibility changes. Pure. */
internal fun prototypeContainerAnimatesSize(node: PrototypeRenderNode): Boolean {
  val repeats =
    when (val source = node.source) {
      is PrototypeBoxNode -> source.repeat != null
      is PrototypeRowNode -> source.repeat != null
      is PrototypeColumnNode -> source.repeat != null
      is PrototypeFlowNode -> source.repeat != null
      is PrototypeGridNode -> source.repeat != null
      else -> false
    }
  return repeats || prototypeChildrenChangeVisibility(node)
}

private fun prototypeChildrenChangeVisibility(node: PrototypeRenderNode): Boolean =
  node.children.any { child ->
    child.source?.visibleWhen != null ||
      (child.role in SIZE_TRANSPARENT_ROLES && prototypeChildrenChangeVisibility(child))
  }

private val SIZE_TRANSPARENT_ROLES = setOf("card", "scroll", "pager")

/**
 * Animates and clips box/row/column containers only with authored repeat or a direct visibleWhen
 * child, recursively looking through card/scroll/pager children only. Nested box/row/column
 * children own their animation, which their parent follows frame by frame. Other containers do not
 * spring for text, style or image-load size changes, and do not clip children while motion is on.
 * No size animation or clipping is added when motion is off.
 */
internal fun Modifier.prototypeAnimateSize(enabled: Boolean): Modifier =
  if (enabled) animateContentSize() else this

/**
 * Scales a node to [scale] while [source] reports a press. The scale animates with a spring when
 * motion is on and snaps otherwise (`motion: "none"` or animator duration scale 0), so a press held
 * for a screenshot is deterministic.
 */
@Composable
internal fun Modifier.prototypePressScale(source: InteractionSource, scale: Float): Modifier {
  val pressed by source.collectIsPressedAsState()
  val spec = if (LocalPrototypeMotion.current) spring<Float>() else snap()
  val current by
    animateFloatAsState(if (pressed) scale else 1f, spec, label = "prototypePressScale")
  return graphicsLayer {
    scaleX = current
    scaleY = current
  }
}
