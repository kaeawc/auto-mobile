package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.ExitTransition
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkOut
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeFlowNode
import dev.jasonpearson.automobile.protocol.PrototypeGridNode
import dev.jasonpearson.automobile.protocol.PrototypeRowNode

/**
 * Whether prototype state changes (visibility, page) animate. Off by default so previews and direct
 * [PrototypeSpecContent] callers stay settled; [PrototypeRuntimeContent] turns it on from the spec.
 */
internal val LocalPrototypeMotion = compositionLocalOf { false }

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
@Composable
internal fun Modifier.prototypeAnimateSize(enabled: Boolean): Modifier {
  if (!enabled) return this
  val activity = LocalPrototypeMotionActivity.current ?: return animateContentSize()
  val owner = remember { Any() }
  DisposableEffect(activity, owner) { onDispose { activity.release(owner) } }
  // The outer modifier sees the animated size and the inner one the target, so the container is
  // moving exactly while they differ. Derived, not event-driven: it corrects itself when the
  // animation node is recreated or interrupted, so the count cannot stay positive.
  val sizes = remember { arrayOfNulls<IntSize>(2) }
  val report = {
    val outer = sizes[0]
    val inner = sizes[1]
    activity.report(owner, outer != null && inner != null && outer != inner)
  }
  return onSizeChanged {
    sizes[0] = it
    report()
  }
    .animateContentSize()
    .onSizeChanged {
      sizes[1] = it
      report()
    }
}

/**
 * Scales a node to [scale] while [source] reports a press. The scale animates with a spring when
 * motion is on and snaps otherwise (`motion: "none"` or animator duration scale 0), so a press held
 * for a screenshot is deterministic.
 */
@Composable
internal fun Modifier.prototypePressScale(source: InteractionSource, scale: Float): Modifier {
  val pressed by source.collectIsPressedAsState()
  val spec =
    if (
      LocalPrototypeMotion.current &&
        LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL
    )
      spring<Float>()
    else snap()
  val target = if (pressed) scale else 1f
  val current by animateFloatAsState(target, spec, label = "prototypePressScale")
  ReportPrototypeMotion { current != target }
  return graphicsLayer {
    scaleX = current
    scaleY = current
  }
}
