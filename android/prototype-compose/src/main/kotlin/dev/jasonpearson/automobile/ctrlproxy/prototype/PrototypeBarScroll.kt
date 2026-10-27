package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*

@OptIn(ExperimentalMaterial3Api::class)
internal class PrototypeBarScrollBinding(
  val top: TopAppBarScrollBehavior? = null,
  val reduced: Boolean = false,
  val extent: Float = 64f,
) {
  var travel by mutableFloatStateOf(0f)
  var hidden by mutableStateOf(false)

  fun fraction(followFinger: Boolean): Float =
    if (followFinger) travel / extent else if (hidden) 1f else 0f

  private fun snap(delta: Float) {
    if (delta != 0f) hidden = delta < 0f
    if (!reduced || top?.isPinned != false) return
    val state = top.state
    if (delta < 0f && state.heightOffset < 0f) state.heightOffset = state.heightOffsetLimit
    if (delta > 0f && state.heightOffset > state.heightOffsetLimit) state.heightOffset = 0f
  }

  val connection =
    object : NestedScrollConnection {
      override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        val consumed = top?.nestedScrollConnection?.onPreScroll(available, source) ?: Offset.Zero
        snap(available.y)
        return consumed
      }

      override fun onPostScroll(
        consumed: Offset,
        available: Offset,
        source: NestedScrollSource,
      ): Offset {
        travel = (travel - consumed.y).coerceIn(0f, extent)
        val result =
          top?.nestedScrollConnection?.onPostScroll(consumed, available, source) ?: Offset.Zero
        snap(consumed.y + available.y)
        return result
      }

      override suspend fun onPreFling(available: Velocity): Velocity =
        if (reduced) Velocity.Zero
        else top?.nestedScrollConnection?.onPreFling(available) ?: Velocity.Zero

      override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
        if (reduced) Velocity.Zero
        else top?.nestedScrollConnection?.onPostFling(consumed, available) ?: Velocity.Zero
    }
}

internal class PrototypeBarScrollBindings(
  val bars: Map<String, PrototypeBarScrollBinding> = emptyMap(),
  val scrolls: Map<String, List<PrototypeBarScrollBinding>> = emptyMap(),
)

internal val LocalPrototypeBarScroll = compositionLocalOf { PrototypeBarScrollBindings() }

private data class ScopedBarNode(val node: PrototypeRenderNode, val screen: String)

private fun barScrollNodes(root: PrototypeRenderNode): List<ScopedBarNode> {
  val result = mutableListOf<ScopedBarNode>()
  fun visit(node: PrototypeRenderNode, screen: String) {
    result.add(ScopedBarNode(node, screen))
    for (child in node.children) visit(
      child,
      if (node.source is PrototypeStackNode) child.identity else screen,
    )
  }
  visit(root, "root")
  return result
}

private fun barScrollTarget(source: PrototypeNode?): String? =
  when (source) {
    is PrototypeTopAppBarNode -> source.scroll
    is PrototypeBottomNavNode -> source.scroll
    is PrototypeTabBarNode -> source.scroll
    else -> null
  }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun rememberPrototypeBarBinding(
  node: PrototypeRenderNode,
  reduced: Boolean,
  extent: Float,
): PrototypeBarScrollBinding {
  val bar = node.source as? PrototypeTopAppBarNode
  val behavior =
    when {
      bar == null -> null
      bar.onScroll == "enterAlways" -> TopAppBarDefaults.enterAlwaysScrollBehavior()
      bar.onScroll == "exitUntilCollapsed" -> TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
      else -> TopAppBarDefaults.pinnedScrollBehavior()
    }
  return remember(behavior, reduced, extent) {
    PrototypeBarScrollBinding(behavior, reduced, extent)
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberPrototypeBarScroll(root: PrototypeRenderNode): PrototypeBarScrollBindings {
  val reduced = LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL
  val extent = with(LocalDensity.current) { 64.dp.toPx() }
  val nodes = remember(root) { barScrollNodes(root) }
  val bars = mutableMapOf<String, PrototypeBarScrollBinding>()
  for ((node, _) in nodes) {
    if (node.source !is PrototypeTopAppBarNode && barScrollTarget(node.source) == null) continue
    key(node.identity) {
      bars[node.identity] = rememberPrototypeBarBinding(node, reduced, extent)
    }
  }
  val scrolls = mutableMapOf<String, List<PrototypeBarScrollBinding>>()
  for ((node, screen) in nodes) {
    if (node.source !is PrototypeScrollNode || node.source.id == null) continue
    scrolls[node.identity] =
      nodes
        .filter { it.screen == screen && barScrollTarget(it.node.source) == node.source.id }
        .mapNotNull { bars[it.node.identity] }
  }
  return PrototypeBarScrollBindings(bars, scrolls)
}

@Composable
internal fun Modifier.prototypeBarScroll(node: PrototypeRenderNode): Modifier {
  var result = this
  for (binding in LocalPrototypeBarScroll.current.scrolls[node.identity].orEmpty()) {
    result = result.nestedScroll(binding.connection)
  }
  return result
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun prototypeTopBarBehavior(node: PrototypeRenderNode): TopAppBarScrollBehavior? =
  LocalPrototypeBarScroll.current.bars[node.identity]?.top

/**
 * A clipped bar slides below its old top, keeping the remaining pixel and semantics bounds equal.
 */
internal fun Modifier.prototypeBarSlide(fraction: Float): Modifier =
  Modifier.layout { measurable, constraints ->
      val placeable = measurable.measure(constraints)
      val shift = if (fraction < 1f) (placeable.height * fraction / (1f - fraction)).toInt() else 0
      layout(placeable.width, placeable.height) { placeable.placeRelative(0, shift) }
    }
    .then(this)
    .clipToBounds()
    .layout { measurable, constraints ->
      val placeable = measurable.measure(constraints)
      layout(placeable.width, (placeable.height * (1f - fraction)).toInt()) {
        placeable.placeRelative(0, 0)
      }
    }
