package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.OverlayListItemCheckbox
import dev.jasonpearson.automobile.protocol.OverlayListItemIcon
import dev.jasonpearson.automobile.protocol.OverlayListItemNode
import dev.jasonpearson.automobile.protocol.OverlayListItemSwitch
import dev.jasonpearson.automobile.protocol.OverlayListItemTrailing
import dev.jasonpearson.automobile.protocol.OverlayNode
import dev.jasonpearson.automobile.protocol.OverlayRadioGroupNode

/**
 * Selection component nodes (#10439, final slice): `radioGroup` and `listItem`. Both own their
 * taps, so [overlayNodeModifier] must not add a second click handler for these roles.
 */
internal val OVERLAY_SELECTION_ROLES = setOf("radioGroup", "listItem")

/** The boolean state key of a `listItem`'s trailing switch or checkbox; null otherwise. */
internal fun overlayListItemToggleKey(node: OverlayNode): String? =
  when (val trailing = (node as? OverlayListItemNode)?.trailing) {
    is OverlayListItemSwitch -> trailing.stateKey
    is OverlayListItemCheckbox -> trailing.stateKey
    else -> null
  }

/** The `testTag` of one radio option: the group's tag, a dot, then the option value. */
internal fun overlayRadioOptionTag(groupTag: String?, value: String): String? = groupTag?.let {
  "$it.$value"
}

/**
 * A group of Material radio buttons bound to a string state key. Each option row is one selectable
 * target carrying the RadioButton role, its label and its selected state, so observe reports
 * `selected` per option and tapOn by label (or `<testTag>.<value>`) picks it. The inner RadioButton
 * is display-only (`onClick = null`).
 */
@Composable
internal fun RenderOverlayRadioGroup(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayRadioGroupNode ?: return
  val actions = source.onTap.orEmpty()
  Column(modifier.selectableGroup()) {
    for (option in source.options) {
      val selected = option.value == node.selectedValue
      Row(
        Modifier.fillMaxWidth()
          .minimumInteractiveComponentSize()
          .selectable(selected, role = Role.RadioButton) {
            interact(OverlayInteraction.Choose(source.stateKey, option.value, actions))
          }
          .semantics {
            text = AnnotatedString(option.label)
            contentDescription = option.label
            overlayRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
          },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        RadioButton(selected, onClick = null)
        Text(option.label, Modifier.clearAndSetSemantics {}, color = overlayForeground(node))
      }
    }
  }
}

/**
 * A Material list item: headline, optional supporting text, optional leading icon and an optional
 * trailing switch, checkbox or icon. The row is one target. With a trailing switch or checkbox it
 * is toggleable (Switch or Checkbox role and checked state) and a tap flips the bound key before
 * running `onTap`; otherwise a row with `onTap` is a Button and one without is inert.
 */
@Composable
internal fun RenderOverlayListItem(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayListItemNode ?: return
  val actions = source.onTap.orEmpty()
  val toggleKey = overlayListItemToggleKey(source)
  val target =
    when {
      toggleKey != null ->
        Modifier.toggleable(
          node.checked,
          role = if (source.trailing is OverlayListItemSwitch) Role.Switch else Role.Checkbox,
        ) {
          interact(OverlayInteraction.Toggle(toggleKey, actions))
        }
      actions.isNotEmpty() ->
        Modifier.clickable(role = Role.Button) { interact(OverlayInteraction.Tap(actions)) }
      else -> Modifier
    }
  val foreground = if (node.style.source.color != null) node.style.color else Color.Unspecified
  ListItem(
    headlineContent = { Text(source.headline, Modifier.clearAndSetSemantics {}) },
    modifier = target.then(modifier),
    supportingContent = source.supporting?.let { supporting -> { Text(supporting) } },
    leadingContent = overlayIcon(source.leadingIcon)?.let { icon -> { Icon(icon, null) } },
    trailingContent =
      source.trailing?.let { trailing ->
        { OverlayListItemTrailingContent(trailing, node.checked) }
      },
    colors =
      ListItemDefaults.colors(
        containerColor =
          if (node.style.background != null) Color.Transparent else ListItemDefaults.containerColor,
        headlineColor = foreground,
        supportingColor = foreground,
        leadingIconColor = foreground,
        trailingIconColor = foreground,
      ),
  )
}

@Composable
private fun OverlayListItemTrailingContent(trailing: OverlayListItemTrailing, checked: Boolean) {
  when (trailing) {
    is OverlayListItemSwitch -> Switch(checked, onCheckedChange = null)
    is OverlayListItemCheckbox -> Checkbox(checked, onCheckedChange = null)
    is OverlayListItemIcon ->
      overlayIcon(trailing.name)?.let { Icon(it, contentDescription = null) }
  }
}
