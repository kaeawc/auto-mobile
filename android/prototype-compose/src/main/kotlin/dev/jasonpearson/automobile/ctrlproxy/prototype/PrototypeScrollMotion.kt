package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import dev.jasonpearson.automobile.protocol.PrototypeScrollMotion

/** One registry per shown tree; state reads happen in the layer block, never on a clock. */
internal class PrototypeScrollOffsets {
  val sources = mutableStateMapOf<String, ScrollState>()
  var targets: Map<String, String> = emptyMap()
}

internal val LocalPrototypeScrollOffsets = compositionLocalOf { PrototypeScrollOffsets() }
internal val LocalPrototypeScrollReduced = compositionLocalOf { false }

internal class PrototypeScrollViewport(
  val owner: String? = null,
  val parent: PrototypeScrollViewport? = null,
) {
  var bounds by mutableStateOf(Rect.Zero)
}

internal val LocalPrototypeScrollViewport = compositionLocalOf<PrototypeScrollViewport?> { null }

internal fun prototypeScrollTargets(root: PrototypeRenderNode): Map<String, String> {
  val result = mutableMapOf<String, String>()
  fun screen(node: PrototypeRenderNode) {
    val nodes = mutableListOf<PrototypeRenderNode>()
    fun collect(current: PrototypeRenderNode) {
      nodes.add(current)
      if (current.role == "stack") current.children.forEach(::screen)
      else current.children.forEach(::collect)
    }
    collect(node)
    nodes.forEach { target ->
      val source = target.source?.scrollLinked?.source
      nodes
        .firstOrNull { it.role == "scroll" && it.source?.id == source }
        ?.let {
          result[target.identity] = it.identity
        }
    }
  }
  screen(root)
  return result
}

@Composable
internal fun RegisterPrototypeScroll(identity: String, scroll: ScrollState) {
  val registry = LocalPrototypeScrollOffsets.current
  DisposableEffect(registry, identity, scroll) {
    registry.sources[identity] = scroll
    onDispose { if (registry.sources[identity] === scroll) registry.sources.remove(identity) }
  }
}

@Composable
internal fun Modifier.prototypeScrollMotion(node: PrototypeRenderNode): Modifier {
  val linked = node.source?.scrollLinked
  val transition = node.source?.scrollTransition
  if (linked == null && transition == null) return this
  val registry = LocalPrototypeScrollOffsets.current
  val inheritedViewport = LocalPrototypeScrollViewport.current
  val viewport =
    if (inheritedViewport?.owner == node.identity) inheritedViewport.parent else inheritedViewport
  val density = LocalDensity.current.density
  val reduced = LocalPrototypeScrollReduced.current
  var bounds by remember { mutableStateOf(Rect.Zero) }
  val layer = rememberGraphicsLayer()
  return onGloballyPositioned {
    bounds = it.findRootCoordinates().localBoundingBoxOf(it, clipBounds = false)
  }
    .drawWithContent {
      val offset =
        registry.targets[node.identity]
          ?.let { registry.sources[it] }
          ?.value
          ?.toDouble()
          ?.div(density) ?: 0.0
      val draw = PrototypeScrollMotion.draw(linked, offset, reduced)
      val phase = prototypeScrollPhase(bounds, viewport?.bounds ?: Rect.Zero, transition?.axis)
      val edge = transition?.edge
      layer.record { this@drawWithContent.drawContent() }
      layer.alpha =
        (draw.alpha * PrototypeScrollMotion.edge(phase, edge?.alpha ?: 1.0, 1.0))
          .coerceIn(0.0, 1.0)
          .toFloat()
      val scale =
        if (reduced) 1.0
        else draw.scale * PrototypeScrollMotion.edge(phase, edge?.scale ?: 1.0, 1.0)
      layer.scaleX = scale.toFloat()
      layer.scaleY = scale.toFloat()
      layer.rotationZ =
        if (reduced) 0f else PrototypeScrollMotion.edge(phase, edge?.rotation ?: 0.0, 0.0).toFloat()
      layer.translationX = (draw.offsetX * density).toFloat()
      layer.translationY = (draw.offsetY * density).toFloat()
      val blur = (draw.blur * density).toFloat()
      layer.renderEffect = if (blur > 0) BlurEffect(blur, blur) else null
      drawLayer(layer)
    }
}

private fun prototypeScrollPhase(bounds: Rect, viewport: Rect, axis: String?): Double {
  val horizontal = axis == "horizontal"
  val extent = if (horizontal) viewport.width else viewport.height
  val center = if (horizontal) bounds.center.x - viewport.left else bounds.center.y - viewport.top
  return if (extent > 0) (2 * center / extent - 1).toDouble() else 0.0
}
