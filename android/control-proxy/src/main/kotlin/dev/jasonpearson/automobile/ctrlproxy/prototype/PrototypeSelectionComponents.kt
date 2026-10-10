package dev.jasonpearson.automobile.ctrlproxy.prototype

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
import dev.jasonpearson.automobile.protocol.PrototypeListItemCheckbox
import dev.jasonpearson.automobile.protocol.PrototypeListItemIcon
import dev.jasonpearson.automobile.protocol.PrototypeListItemNode
import dev.jasonpearson.automobile.protocol.PrototypeListItemSwitch
import dev.jasonpearson.automobile.protocol.PrototypeListItemTrailing
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeRadioGroupNode

/**
 * Selection component nodes (#10439, final slice): `radioGroup` and `listItem`. Both own their
 * taps, so [prototypeNodeModifier] must not add a second click handler for these roles.
 */
internal val PROTOTYPE_SELECTION_ROLES = setOf("radioGroup", "listItem")

/** The boolean state key of a `listItem`'s trailing switch or checkbox; null otherwise. */
internal fun prototypeListItemToggleKey(node: PrototypeNode): String? =
  when (val trailing = (node as? PrototypeListItemNode)?.trailing) {
    is PrototypeListItemSwitch -> trailing.stateKey
    is PrototypeListItemCheckbox -> trailing.stateKey
    else -> null
  }

/** The `testTag` of one radio option: the group's tag, a dot, then the option value. */
internal fun prototypeRadioOptionTag(groupTag: String?, value: String): String? = groupTag?.let {
  "$it.$value"
}

/**
 * A group of Material radio buttons bound to a string state key. Each option row is one selectable
 * target carrying the RadioButton role, its label and its selected state, so observe reports
 * `selected` per option and tapOn by label (or `<testTag>.<value>`) picks it. The inner RadioButton
 * is display-only (`onClick = null`).
 */
@Composable
internal fun RenderPrototypeRadioGroup(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeRadioGroupNode ?: return
  val actions = source.onTap.orEmpty()
  Column(modifier.selectableGroup()) {
    for (option in source.options) {
      val selected = option.value == node.selectedValue
      Row(
        Modifier.fillMaxWidth()
          .minimumInteractiveComponentSize()
          .selectable(selected, role = Role.RadioButton) {
            interact(PrototypeInteraction.Choose(source.stateKey, option.value, actions))
          }
          .semantics {
            text = AnnotatedString(option.label)
            contentDescription = option.label
            prototypeRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
          },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        RadioButton(selected, onClick = null)
        Text(option.label, Modifier.clearAndSetSemantics {}, color = prototypeForeground(node))
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
internal fun RenderPrototypeListItem(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeListItemNode ?: return
  val actions = source.onTap.orEmpty()
  val toggleKey = prototypeListItemToggleKey(source)
  val target =
    when {
      toggleKey != null ->
        Modifier.toggleable(
          node.checked,
          role = if (source.trailing is PrototypeListItemSwitch) Role.Switch else Role.Checkbox,
        ) {
          interact(PrototypeInteraction.Toggle(toggleKey, actions))
        }
      actions.isNotEmpty() ->
        Modifier.clickable(role = Role.Button) { interact(PrototypeInteraction.Tap(actions)) }
      else -> Modifier
    }
  val foreground = prototypeThemedColor(null, node.style.source.color) ?: Color.Unspecified
  ListItem(
    headlineContent = { Text(source.headline, Modifier.clearAndSetSemantics {}) },
    modifier = target.then(modifier),
    supportingContent = source.supporting?.let { supporting -> { Text(supporting) } },
    leadingContent = prototypeIcon(source.leadingIcon)?.let { icon -> { Icon(icon, null) } },
    trailingContent =
      source.trailing?.let { trailing ->
        { PrototypeListItemTrailingContent(trailing, node.checked) }
      },
    colors =
      ListItemDefaults.colors(
        containerColor =
          if (node.style.source.background != null) Color.Transparent
          else ListItemDefaults.containerColor,
        headlineColor = foreground,
        supportingColor = foreground,
        leadingIconColor = foreground,
        trailingIconColor = foreground,
      ),
  )
}

@Composable
private fun PrototypeListItemTrailingContent(
  trailing: PrototypeListItemTrailing,
  checked: Boolean,
) {
  when (trailing) {
    is PrototypeListItemSwitch -> Switch(checked, onCheckedChange = null)
    is PrototypeListItemCheckbox -> Checkbox(checked, onCheckedChange = null)
    is PrototypeListItemIcon ->
      prototypeIcon(trailing.name)?.let { Icon(it, contentDescription = null) }
  }
}
