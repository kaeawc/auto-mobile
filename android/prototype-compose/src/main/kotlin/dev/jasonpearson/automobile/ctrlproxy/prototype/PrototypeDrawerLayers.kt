package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.*

internal val PROTOTYPE_ANIMATED_MODAL_ROLES =
  setOf("drawer", "bottomSheet", "dialog", "snackbar", "menu")

/** Retains the last open panel until AnimatedVisibility finishes, including tree removal. */
internal class PrototypeDrawerLayers {
  val retained = mutableStateMapOf<String, PrototypeRenderNode>()
}

internal val LocalPrototypeDrawerLayers = compositionLocalOf { PrototypeDrawerLayers() }

@Composable
internal fun prototypeModalLayers(root: PrototypeRenderNode): List<PrototypeRenderNode> {
  val drawers = LocalPrototypeDrawerLayers.current
  val current = remember(root) { modalPrototypeSheets(root, includeClosedDrawers = true) }
  SideEffect {
    current
      .filter { it.role in PROTOTYPE_ANIMATED_MODAL_ROLES && it.sheetOpen }
      .forEach { drawers.retained[it.identity] = it }
  }
  val ids = current.map { it.identity }.toSet()
  val closing =
    drawers.retained.values.filter { it.identity !in ids }.map { it.copy(sheetOpen = false) }
  return current.mapNotNull { node ->
    if (node.role in PROTOTYPE_ANIMATED_MODAL_ROLES && !node.sheetOpen)
      drawers.retained[node.identity]?.copy(sheetOpen = false)
    else node
  } + closing
}
