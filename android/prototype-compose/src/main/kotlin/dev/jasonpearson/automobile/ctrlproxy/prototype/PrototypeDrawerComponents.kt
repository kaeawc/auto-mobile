package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*

@Composable
internal fun RenderPrototypeDrawer(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeDrawerNode ?: return
  val motion = LocalPrototypeMotion.current
  val reduced = LocalPrototypeReducedMotion.current
  val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
  val state = remember(node.identity) { MutableTransitionState(false) }
  state.targetState = node.sheetOpen
  ReportPrototypeMotion { !state.isIdle }
  val layers = LocalPrototypeDrawerLayers.current
  LaunchedEffect(state, node.sheetOpen) {
    snapshotFlow { state.isIdle && !state.currentState && !state.targetState }
      .collect { closed ->
        if (closed) layers.retained.remove(node.identity)
      }
  }
  val transition = if (source.edge == "start") "slideStart" else "slideEnd"
  val enter =
    when {
      !motion -> EnterTransition.None
      reduced -> fadeIn(tween(300))
      else ->
        slideInHorizontally(tween(300, easing = LinearOutSlowInEasing)) {
          prototypeSlideOffset(transition, it, rtl)
        }
    }
  val exit =
    when {
      !motion -> ExitTransition.None
      reduced -> fadeOut(tween(300))
      else ->
        slideOutHorizontally(tween(300, easing = LinearOutSlowInEasing)) {
          prototypeSlideOffset(transition, it, rtl)
        }
    }
  AnimatedVisibility(
    state,
    enter = if (motion) fadeIn(tween(300)) else EnterTransition.None,
    exit = if (motion) fadeOut(tween(300)) else ExitTransition.None,
  ) {
    PrototypeDrawerBody(node, modifier.animateEnterExit(enter, exit), interact)
  }
}

@Composable
private fun PrototypeDrawerBody(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeDrawerNode ?: return
  val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
  val requester = remember(node.identity) { FocusRequester() }
  LaunchedEffect(node.sheetOpen) { if (node.sheetOpen) requester.requestFocus() }
  BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
    Box(
      Modifier.fillMaxSize()
        .background(
          prototypeThemedScrim(null, source.scrim)
            ?: prototypeSheetScrimFallback(prototypePalette()),
        )
        .clickable { interact(PrototypeInteraction.SheetDismiss(source.openWhen)) }
        .semantics {
          prototypePartTag(node.testTag, "close")?.let { testTag = it }
        },
    )
    Surface(
      modifier
        .align(if (source.edge == "start") Alignment.CenterStart else Alignment.CenterEnd)
        .width(minOf(320.dp, (maxWidth - 56.dp).coerceAtLeast(0.dp)))
        .fillMaxHeight()
        .focusRequester(requester)
        .focusable()
        .semantics {
          paneTitle = "Drawer"
          isTraversalGroup = true
        }
        .drawerDismissSwipe(source, rtl, interact)
        .clickable { source.onTap?.let { interact(PrototypeInteraction.Tap(it)) } },
      color = MaterialTheme.colorScheme.surface,
      tonalElevation = 3.dp,
      shadowElevation = 3.dp,
    ) {
      Column {
        node.children.forEach { child ->
          key(child.identity) { RenderPrototypeNode(child, interact) }
        }
      }
    }
  }
}

private fun Modifier.drawerDismissSwipe(
  source: PrototypeDrawerNode,
  rtl: Boolean,
  interact: (PrototypeInteraction) -> Unit,
): Modifier =
  if (!source.dismissOnSwipe) this
  else
    pointerInput(source.openWhen, source.edge, rtl) {
      var drag = 0f
      val towardLeft = (source.edge == "start") != rtl
      detectHorizontalDragGestures(
        onDragStart = { drag = 0f },
        onHorizontalDrag = { change, amount ->
          change.consume()
          drag += if (towardLeft) -amount else amount
        },
        onDragCancel = { drag = 0f },
        onDragEnd = {
          if (
            settlePrototypeSheet(
              listOf(size.width.toDouble()),
              size.width.toDouble(),
              drag.toDouble(),
              true,
            ) == null
          )
            interact(PrototypeInteraction.SheetDismiss(source.openWhen))
          drag = 0f
        },
      )
    }
