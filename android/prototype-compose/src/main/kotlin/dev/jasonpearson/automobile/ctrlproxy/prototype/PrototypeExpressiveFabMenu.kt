package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeFloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeFabMenuItem
import dev.jasonpearson.automobile.protocol.PrototypeFabNode

/**
 * A FAB whose tap opens a menu of 2-6 items stacked above it (`fab.menu`). The FAB runs its own
 * `onTap` (if any) and toggles the menu; an item tap closes the menu, then runs the item's `onTap`.
 * Items are tagged `<testTag>.items.<index>`. While open the FAB shows a close icon.
 */
@Composable
internal fun RenderPrototypeFabMenu(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeFabNode ?: return
  val menu = source.menu ?: return
  var open by remember(node.identity) { mutableStateOf(false) }
  val expansion by animatePrototypeMenuExpansion(open)
  // The node modifier (parent layout data such as weight, and the node's semantics) goes on the
  // outer layout; the FAB carries its own accessible name.
  Column(
    modifier,
    horizontalAlignment = Alignment.End,
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (open || expansion > 0f) {
      PrototypeFabMenuItems(menu.items, node.testTag, open, expansion) { item ->
        open = false
        interact(PrototypeInteraction.Tap(item.onTap))
      }
    }
    PrototypeFabMenuButton(node, source, open) {
      source.onTap?.takeIf { it.isNotEmpty() }?.let { interact(PrototypeInteraction.Tap(it)) }
      open = !open
    }
  }
}

/** The menu items above the FAB, tagged `<testTag>.items.<index>`. */
@Composable
private fun PrototypeFabMenuItems(
  items: List<PrototypeFabMenuItem>,
  testTag: String?,
  open: Boolean,
  expansion: Float,
  pick: (PrototypeFabMenuItem) -> Unit,
) {
  items.forEachIndexed { index, item ->
    Surface(
      shape = CircleShape,
      color = MaterialTheme.colorScheme.primaryContainer,
      contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
      modifier =
        Modifier.prototypeMenuExpansion(expansion)
          .heightIn(min = 56.dp)
          .clickable(enabled = open, role = Role.Button) { pick(item) }
          .semantics(mergeDescendants = true) {
            contentDescription = item.label
            prototypePartTag(testTag, "items.$index")?.let { this.testTag = it }
          },
    ) {
      Row(
        Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        prototypeIcon(item.icon)?.let { Icon(it, contentDescription = null) }
        Text(item.label, Modifier.clearAndSetSemantics {})
      }
    }
  }
}

/**
 * The FAB itself, keeping its authored label and size; it shows a close icon while the menu is open
 * and carries its own accessible name, since the node's semantics sit on the outer layout.
 */
@Composable
private fun PrototypeFabMenuButton(
  node: PrototypeRenderNode,
  source: PrototypeFabNode,
  open: Boolean,
  onClick: () -> Unit,
) {
  val icon: @Composable () -> Unit = {
    prototypeIcon(if (open) "close" else source.icon)?.let { Icon(it, contentDescription = null) }
  }
  // The label and description are read from the render node: state placeholders are resolved there.
  val label = node.text.takeIf { source.label != null }
  val fab = Modifier.semantics {
    contentDescription = node.contentDescription ?: label ?: source.icon
  }
  when {
    label != null ->
      ExtendedFloatingActionButton(
        text = { Text(label, Modifier.clearAndSetSemantics {}) },
        icon = icon,
        onClick = onClick,
        modifier = fab,
      )
    source.size == "small" ->
      SmallFloatingActionButton(onClick, fab, shape = CircleShape, content = icon)
    source.size == "large" -> LargeFloatingActionButton(onClick, fab, content = icon)
    else ->
      FloatingActionButton(
        onClick,
        fab,
        shape = if (open) CircleShape else MaterialTheme.shapes.large,
        content = icon,
      )
  }
}
