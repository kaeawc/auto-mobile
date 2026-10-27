@file:OptIn(androidx.compose.animation.ExperimentalSharedTransitionApi::class)

package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.protocol.resolvedSharedKey

internal data class PrototypeStackZoomScope(
  val key: String?,
  val destination: Boolean,
  val rootIdentity: String,
  val visibility: AnimatedVisibilityScope,
)

internal val LocalPrototypeStackZoom = compositionLocalOf<PrototypeStackZoomScope?> { null }

/** Reuse the surrounding coordinate space; a standalone zoom keeps parent data on its Box. */
@Composable
internal fun PrototypeStackSharedRoot(
  zoom: Boolean,
  modifier: Modifier,
  content: @Composable (Modifier) -> Unit,
) {
  if (!zoom || LocalPrototypeSharedTransition.current != null) {
    content(modifier)
    return
  }
  SharedTransitionScope { sharedModifier ->
    val scope = this
    Box(modifier.then(sharedModifier), propagateMinConstraints = true) {
      ReportPrototypeMotion { scope.isTransitionActive }
      CompositionLocalProvider(LocalPrototypeSharedTransition provides scope) { content(Modifier) }
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
    if (enabled && key != null) {
      PrototypeStackZoomScope(
        key,
        change.zoomTarget == target,
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
    else node.source?.resolvedSharedKey?.takeIf { it == zoom.key }
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
