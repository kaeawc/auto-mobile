package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.clearAndSetSemantics

/** Smallest subtree (node count, the node included) worth keeping composed while hidden. */
internal const val PROTOTYPE_RETAIN_MIN_NODES = 24
/** Most render nodes one prototype keeps composed-but-hidden through retention. */
internal const val PROTOTYPE_RETAIN_MAX_NODES = 512

private val RETENTION_TRANSITIONS = setOf("fade", "none")
private val RETENTION_INLINE_ROLES =
  setOf("box", "row", "column", "flow", "grid", "carousel", "scroll", "card", "pager")
private val RETENTION_EXCLUDED_ROLES =
  setOf(
    "textField",
    "searchBar",
    "pager",
    "timePicker",
    "datePicker",
    "progress",
    "bottomSheet",
    "dialog",
    "snackbar",
    "menu",
    "select",
  )
private val RETENTION_SPACED_ARRANGEMENTS = setOf("spaceBetween", "spaceAround", "spaceEvenly")

/** Identities of the `visibleWhen` nodes whose subtree stays composed while hidden. Pure. */
internal fun prototypeRetainedSubtrees(root: PrototypeRenderNode): Set<String> {
  // One tree traversal: reserve pre-order slots, then fill size/exclusion summaries bottom-up.
  // Intervals in that order let the budget scan count nested candidates without another tree walk.
  val entries = mutableListOf<RetentionEntry>()
  collectRetentionEntries(root, parent = null, inline = true, entries = entries)
  val retained = mutableSetOf<String>()
  var coveredUntil = 0
  var coveredNodes = 0
  entries.forEachIndexed { index, entry ->
    if (entry.eligible && !entry.excluded && entry.size >= PROTOTYPE_RETAIN_MIN_NODES) {
      val extra = if (index < coveredUntil) 0 else entry.size
      if (coveredNodes + extra <= PROTOTYPE_RETAIN_MAX_NODES) {
        retained.add(entry.node.identity)
        coveredNodes += extra
        coveredUntil = maxOf(coveredUntil, index + entry.size)
      }
    }
  }
  return retained
}

private class RetentionEntry(val node: PrototypeRenderNode, val eligible: Boolean) {
  var size = 1
  var excluded = isLayeredPrototypeAnchor(node) || node.role in RETENTION_EXCLUDED_ROLES
}

private fun collectRetentionEntries(
  node: PrototypeRenderNode,
  parent: PrototypeRenderNode?,
  inline: Boolean,
  entries: MutableList<RetentionEntry>,
): RetentionEntry {
  val entry = RetentionEntry(node, inline && retentionCandidate(node, parent))
  entries.add(entry)
  node.children.forEach { child ->
    val summary =
      collectRetentionEntries(child, node, inline && node.role in RETENTION_INLINE_ROLES, entries)
    entry.size += summary.size
    entry.excluded = entry.excluded || summary.excluded
  }
  return entry
}

private fun retentionCandidate(node: PrototypeRenderNode, parent: PrototypeRenderNode?): Boolean =
  node.source?.visibleWhen != null &&
    node.source.transition?.type in RETENTION_TRANSITIONS &&
    retentionNeutralParent(parent) &&
    node.style.source.weight == null &&
    !isLayeredPrototypeAnchor(node)

private fun retentionNeutralParent(parent: PrototypeRenderNode?): Boolean {
  val node = parent ?: return false
  return when (node.role) {
    "box",
    "scroll" -> true
    "row",
    "column" ->
      (node.style.source.spacing == null || node.style.source.spacing == 0.0) &&
        node.style.source.arrangement !in RETENTION_SPACED_ARRANGEMENTS
    // A zero-sized retained child can still consume a wrapping line or grid cell.
    "flow",
    "grid",
    "carousel" -> false
    else -> false
  }
}

internal val LocalPrototypeRetainedSubtrees = compositionLocalOf<Set<String>> { emptySet() }
/** Moves each time a retained subtree is shown again after it had settled hidden. */
internal val LocalPrototypeShowEpoch = compositionLocalOf { 0 }

/** Show history kept across changes in subtree retention membership. */
internal class RetainedVisibilityHistory {
  var shown = false
  var settledHidden = false
  var epoch = 0

  /** Clears a settled hide after the subtree is shown outside retention. */
  fun clearSettledHidden() {
    settledHidden = false
  }

  fun update(visible: Boolean, hidden: Boolean) {
    if (visible && settledHidden && shown) epoch++
    shown = shown || visible
    settledHidden = hidden
  }
}

/**
 * Retains fade/none subtrees of >= 24 nodes, up to 512 hidden-composed nodes per prototype, only
 * after first show. Candidates exclude layered anchors, fields, pagers, pickers, progress and
 * hoisted modals. Settled-hidden content is out of layout, draw, hit-testing and semantics. Emits
 * one layout; fading exits keep their size and input until alpha reaches zero. Re-showing after a
 * settled hide advances the epoch so scroll state resets as it would after disposal.
 */
@Composable
internal fun PrototypeRetainedVisibility(
  visible: Boolean,
  fade: Boolean,
  history: RetainedVisibilityHistory,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  // Initially visible starts at alpha 1; initially hidden keeps alpha 0 for its first enter fade.
  val alpha = retainedVisibilityAlpha(visible, fade)
  val hidden by
    remember(visible, fade, alpha) { derivedStateOf { !visible && (!fade || alpha.value == 0f) } }
  history.update(visible, hidden)
  val epoch = LocalPrototypeShowEpoch.current + history.epoch
  val visibilityModifier =
    modifier
      .then(if (hidden) Modifier.clearAndSetSemantics {} else Modifier)
      .then(if (fade) Modifier.graphicsLayer { this.alpha = alpha.value } else Modifier)
  Layout(
    modifier = visibilityModifier,
    content = {
      if (history.shown) {
        CompositionLocalProvider(LocalPrototypeShowEpoch provides epoch, content = content)
      }
    },
  ) { measurables, constraints ->
    if (hidden) {
      layout(0, 0) {}
    } else {
      val placeables = measurables.map { it.measure(constraints) }
      layout(placeables.maxOfOrNull { it.width } ?: 0, placeables.maxOfOrNull { it.height } ?: 0) {
        placeables.forEach { it.place(0, 0) }
      }
    }
  }
}

@Composable
private fun retainedVisibilityAlpha(visible: Boolean, fade: Boolean): State<Float> =
  if (fade) {
    animateFloatAsState(
      if (visible) 1f else 0f,
      spring(stiffness = Spring.StiffnessMediumLow),
      label = "prototypeRetainedVisibility",
    )
  } else rememberUpdatedState(if (visible) 1f else 0f)
