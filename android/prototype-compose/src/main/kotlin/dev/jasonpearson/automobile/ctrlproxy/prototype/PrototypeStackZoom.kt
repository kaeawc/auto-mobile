@file:OptIn(androidx.compose.animation.ExperimentalSharedTransitionApi::class)

package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.resolvedSharedKey

internal data class PrototypeStackZoomScope(
  val key: String?,
  val destination: Boolean,
  val rootIdentity: String,
  val visibility: AnimatedVisibilityScope,
)

internal val LocalPrototypeStackZoom = compositionLocalOf<PrototypeStackZoomScope?> { null }

/** A stack owns its coordinate space, independent of visibility pairs elsewhere in the tree. */
@Composable
internal fun PrototypeStackSharedRoot(root: PrototypeNode, content: @Composable () -> Unit) {
  if (!remember(root) { prototypeHasSharedKey(root) }) {
    content()
    return
  }
  SharedTransitionScope { sharedModifier ->
    val scope = this
    Box(sharedModifier, propagateMinConstraints = true) {
      ReportPrototypeMotion { scope.isTransitionActive }
      CompositionLocalProvider(LocalPrototypeSharedTransition provides scope) { content() }
    }
  }
}

@Composable
internal fun PrototypeStackZoomScreen(
  change: PrototypeStackChange?,
  target: Pair<Int, String>,
  root: PrototypeRenderNode,
  visibility: AnimatedVisibilityScope,
  content: @Composable () -> Unit,
) {
  val enabled =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL
  val key = change?.source
  val zoom =
    if (enabled) {
      PrototypeStackZoomScope(
        key,
        key != null && change.zoomTarget == target,
        root.identity,
        visibility,
      )
    } else null
  CompositionLocalProvider(LocalPrototypeStackZoom provides zoom) { content() }
}

@Composable
internal fun Modifier.prototypeStackZoomNode(node: PrototypeRenderNode): Modifier {
  val zoom = LocalPrototypeStackZoom.current ?: return this
  val key =
    if (zoom.destination && node.identity == zoom.rootIdentity) zoom.key
    else
      node.source?.resolvedSharedKey?.takeIf { node.source.visibleWhen == null || it == zoom.key }
  return prototypeStackZoomBounds(key)
}

@Composable
private fun Modifier.prototypeStackZoomBounds(key: String?): Modifier {
  val zoom = LocalPrototypeStackZoom.current ?: return this
  val scope = LocalPrototypeSharedTransition.current ?: return this
  if (key == null) return this
  return with(scope) {
    this@prototypeStackZoomBounds.sharedBounds(
      rememberSharedContentState(key),
      animatedVisibilityScope = zoom.visibility,
      boundsTransform = { _, _ -> tween(300) },
    )
  }
}
