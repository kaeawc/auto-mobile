@file:OptIn(androidx.compose.animation.ExperimentalSharedTransitionApi::class)

package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.protocol.PrototypeNode

private val LocalPrototypeSharedTransition = compositionLocalOf<SharedTransitionScope?> { null }

/**
 * Keys whose two nodes are shown at the same time; they cannot share bounds, so they are skipped.
 */
private val LocalPrototypeSharedConflicts = compositionLocalOf<Set<String>> { emptySet() }

/**
 * Shared keys with more than one node currently shown. Compose matches a key against one visible
 * node, so a pair that is visible together (the author's choice) is left to the ordinary visibility
 * animation rather than handed to the shared transition.
 */
internal fun prototypeSharedConflicts(root: PrototypeRenderNode): Set<String> {
  val shown = HashMap<String, Int>()
  fun visit(node: PrototypeRenderNode) {
    if (!node.visible) return
    node.source?.sharedKey?.let { shown.merge(it, 1, Int::plus) }
    node.children.forEach(::visit)
  }
  visit(root)
  return shown.filterValues { it > 1 }.keys
}

/** One root coordinate space, allocated only when the authored tree contains shared keys. */
@Composable
internal fun PrototypeSharedRoot(root: PrototypeRenderNode, content: @Composable () -> Unit) {
  val hasKeys = remember(root.source) { root.source?.let(::prototypeHasSharedKey) == true }
  if (hasKeys) {
    // SharedTransitionLayout's own Box drops the incoming minimum constraints; keep them so a
    // keyed spec lays out like an unkeyed one.
    SharedTransitionScope { sharedModifier ->
      val scope = this
      Box(sharedModifier, propagateMinConstraints = true) {
        // Shared bounds can outlive an authored none/fade visibility transition.
        ReportPrototypeMotion { scope.isTransitionActive }
        CompositionLocalProvider(
          LocalPrototypeSharedTransition provides scope,
          LocalPrototypeSharedConflicts provides remember(root) { prototypeSharedConflicts(root) },
        ) {
          content()
        }
      }
    }
  } else content()
}

private fun prototypeHasSharedKey(node: PrototypeNode): Boolean =
  node.sharedKey != null || prototypeDescendants(node).any(::prototypeHasSharedKey)

/** sharedBounds crossfades differing content (row/card), while sharing its position and size. */
@Composable
internal fun Modifier.prototypeSharedBounds(
  node: PrototypeRenderNode,
  visibility: AnimatedVisibilityScope,
): Modifier {
  val key = node.source?.sharedKey ?: return this
  val scope = LocalPrototypeSharedTransition.current ?: return this
  if (LocalPrototypeMotionProfile.current != PrototypeMotionProfile.FULL) return this
  if (key in LocalPrototypeSharedConflicts.current) return this
  return with(scope) {
    sharedBounds(rememberSharedContentState(key), animatedVisibilityScope = visibility)
  }
}
