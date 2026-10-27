package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.RippleConfiguration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.stackTransition

internal fun namespaceIndicationEnabled(style: String?, motion: Boolean): Boolean =
  motion && style != "none"

/** Each node owns its indication; a parent's namespace never changes its children's controls. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PrototypeNamespaceContent(
  node: PrototypeRenderNode,
  content: @Composable () -> Unit,
) {
  val enabled =
    namespaceIndicationEnabled(node.source?.android?.indication, LocalPrototypeMotion.current)
  CompositionLocalProvider(
    LocalRippleConfiguration provides if (enabled) RippleConfiguration() else null,
  ) {
    content()
  }
}

/**
 * Android's cross-activity treatment uses horizontal movement plus fade within this one activity.
 */
internal fun namespaceStackAnimation(
  source: PrototypeStackNode,
  change: PrototypeStackChange?,
  motion: Boolean,
  reduced: Boolean,
): StackAnimation {
  val base = resolveStackAnimation(source.stackTransition, change, motion, reduced)
  if (change?.direction != "pop") return base
  return when (source.android?.predictiveBack?.style) {
    "none" -> base.copy(kind = StackTransitionKind.None, fadeThrough = false)
    "crossActivity" ->
      if (motion && !reduced) base.copy(kind = StackTransitionKind.SharedAxisX, fadeThrough = false)
      else base
    else -> base
  }
}

/** No seek target is exposed for a stack that opts out of predictive scrubbing. */
internal fun namespaceBackPreview(
  source: PrototypeStackNode,
  preview: PrototypeRuntimeSnapshot?,
): PrototypeRuntimeSnapshot? = preview.takeUnless {
  source.android?.predictiveBack?.style == "none"
}
