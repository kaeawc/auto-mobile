package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.clearAndSetSemantics
import dev.jasonpearson.automobile.protocol.PrototypeTooltipNode

/** Keeps page semantics and focus blocked until the last drawer finishes its exit. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun PrototypeModalPage(
  modals: List<PrototypeRenderNode>,
  content: @Composable () -> Unit,
) {
  val pageFocus = remember { FocusRequester() }
  val layers = LocalPrototypeMenuLayers.current
  val targets = LocalPrototypeTooltipTargets.current
  val pageBlocked =
    LocalPrototypeDrawerLayers.current.retained.isNotEmpty() ||
      modals.any { blocksPrototypePage(it, layers, targets) }
  LaunchedEffect(pageBlocked) {
    if (pageBlocked) pageFocus.saveFocusedChild() else pageFocus.restoreFocusedChild()
  }
  // The page box takes the fill: it is the root's parent and must measure the window.
  Box(
    Modifier.focusRequester(pageFocus)
      .focusGroup()
      .then(if (LocalPrototypeFillsWindow.current) Modifier.fillWhenEmpty() else Modifier)
      .then(if (pageBlocked) Modifier.clearAndSetSemantics {} else Modifier),
  ) {
    content()
  }
}

private fun blocksPrototypePage(
  node: PrototypeRenderNode,
  layers: PrototypeMenuLayers,
  targets: Map<String, String>,
): Boolean {
  if (!node.sheetOpen) return false
  if (node.role in setOf("dialog", "menu", "drawer")) return true
  return (node.source as? PrototypeTooltipNode)?.spotlight != null &&
    prototypeTooltipHasTarget(node, layers, targets)
}
