package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics

internal val LocalPrototypeModalInputEnabled = compositionLocalOf { true }

private val LocalPrototypeModalProgress = compositionLocalOf { 1f }

/** Retain closed panels until their fade finishes; reopening reverses the same transition. */
@Composable
internal fun PrototypeModalMotion(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
  content: @Composable ((PrototypeInteraction) -> Unit) -> Unit,
) {
  val modalInteract: (PrototypeInteraction) -> Unit = { if (node.sheetOpen) interact(it) }
  if (node.role !in PROTOTYPE_ANIMATED_MODAL_ROLES || node.role == "drawer") {
    content(modalInteract)
    return
  }
  val layers = LocalPrototypeDrawerLayers.current
  if (!prototypeModalMotionEnabled()) {
    if (node.sheetOpen) content(modalInteract)
    else SideEffect { layers.retained.remove(node.identity) }
    return
  }
  val state = remember(node.identity) { MutableTransitionState(false) }
  state.targetState = node.sheetOpen
  val transition = rememberTransition(state, label = "prototypeModal")
  val progress by
    transition.animateFloat(
      transitionSpec = { tween(300) },
      label = "modalProgress",
    ) {
      if (it) 1f else 0f
    }
  ReportPrototypeMotion { !state.isIdle }
  LaunchedEffect(state, node.sheetOpen) {
    snapshotFlow { state.isIdle && !state.currentState && !state.targetState }
      .collect {
        if (it) layers.retained.remove(node.identity)
      }
  }
  if (node.sheetOpen || state.currentState || !state.isIdle) {
    CompositionLocalProvider(
      LocalPrototypeModalProgress provides progress,
      LocalPrototypeModalInputEnabled provides node.sheetOpen,
    ) {
      val semantics = if (node.sheetOpen) Modifier else Modifier.clearAndSetSemantics {}
      Box(semantics.graphicsLayer { alpha = progress }) { content(modalInteract) }
    }
  }
}

@Composable
private fun prototypeModalMotionEnabled(): Boolean =
  LocalPrototypeMotion.current && LocalPrototypeMotionProfile.current != PrototypeMotionProfile.OFF

/** Scrims only fade; translation and scale belong to the surface within them. */
@Composable
internal fun Modifier.prototypeModalSurface(type: String): Modifier {
  val progress = LocalPrototypeModalProgress.current
  if (LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL || progress == 1f)
    return this
  return graphicsLayer {
    if (type == "slide") translationY = size.height * (1f - progress)
    else {
      scaleX = 0.92f + 0.08f * progress
      scaleY = scaleX
    }
  }
}

/** Follow the pointer instantly, then spring from the released height to its detent. */
@Composable
internal fun prototypeSettledSheetHeight(target: Float, dragging: Boolean): Float {
  val spatial =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL
  if (!spatial) return target
  val height by
    animateFloatAsState(
      target,
      if (spatial && !dragging) spring() else snap(),
      label = "sheetDetent",
    )
  ReportPrototypeMotion { height != target }
  return height
}
