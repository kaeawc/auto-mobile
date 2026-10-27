package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.focusable
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester

internal val LocalPrototypeTooltipTargets = compositionLocalOf<Map<String, String>> { emptyMap() }
internal val LocalPrototypeTargetFocus = compositionLocalOf {
  mutableMapOf<String, FocusRequester>()
}

/** The active render tree already excludes inactive stack screens and expands repeat identities. */
internal fun prototypeTooltipTargets(root: PrototypeRenderNode): Map<String, String> = buildMap {
  val requested = mutableSetOf<String>()
  fun visit(node: PrototypeRenderNode) {
    if (!node.visible) return
    (node.source as? dev.jasonpearson.automobile.protocol.PrototypeTooltipNode)
      ?.anchorTo
      ?.let(requested::add)
    node.source?.id?.let { put(it, node.identity) }
    val children =
      if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
    children.forEach(::visit)
  }
  visit(root)
  keys.retainAll(requested)
}

internal fun Modifier.prototypeTargetBounds(node: PrototypeRenderNode): Modifier = composed {
  val layers = LocalPrototypeMenuLayers.current
  val targets = LocalPrototypeTooltipTargets.current
  val focus = LocalPrototypeTargetFocus.current
  val targeted = node.identity in targets.values
  val measured = targeted || node.children.any { it.role == "menu" }
  if (measured) {
    val requester = remember(node.identity) { FocusRequester() }
    DisposableEffect(node.identity, layers) {
      if (targeted) focus[node.identity] = requester
      onDispose {
        layers.bounds.remove(node.identity)
        focus.remove(node.identity)
      }
    }
    this.prototypeMenuBounds(node.identity, layers)
      .then(if (targeted) Modifier.focusRequester(requester).focusable() else Modifier)
  } else this
}
