package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.*

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
      .filter { it.role == "drawer" && it.sheetOpen }
      .forEach { drawers.retained[it.identity] = it }
  }
  val ids = current.map { it.identity }.toSet()
  val closing =
    drawers.retained.values.filter { it.identity !in ids }.map { it.copy(sheetOpen = false) }
  return current.map { node ->
    if (node.role == "drawer" && !node.sheetOpen)
      drawers.retained[node.identity]?.copy(sheetOpen = false) ?: node
    else node
  } + closing
}
