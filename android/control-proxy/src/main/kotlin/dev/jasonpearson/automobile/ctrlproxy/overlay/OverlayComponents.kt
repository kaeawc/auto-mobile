package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.OverlayButtonNode
import dev.jasonpearson.automobile.protocol.OverlayCheckboxNode
import dev.jasonpearson.automobile.protocol.OverlayNode
import dev.jasonpearson.automobile.protocol.OverlaySwitchNode

/**
 * Material 3 component nodes (#10439). Each draws its own Material control and owns its tap, so
 * [overlayNodeModifier] must not add a second click handler for these roles.
 */
internal val OVERLAY_COMPONENT_ROLES = setOf("switch", "checkbox", "button")

/** The boolean state key a `switch` or `checkbox` is bound to; null for every other node. */
internal fun overlayToggleKey(node: OverlayNode): String? =
  when (node) {
    is OverlaySwitchNode -> node.stateKey
    is OverlayCheckboxNode -> node.stateKey
    else -> null
  }

/**
 * A labelled switch or checkbox. The whole row is one toggleable target carrying the Switch or
 * Checkbox role and its checked state, so observe reports `checkable`/`checked` and tapOn by
 * `testTag` toggles it. The inner Material control is display-only (`onCheckedChange = null`).
 */
@Composable
internal fun RenderOverlayToggle(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source ?: return
  val key = overlayToggleKey(source) ?: return
  val actions = source.onTap.orEmpty()
  val isSwitch = node.role == "switch"
  Row(
    Modifier.minimumInteractiveComponentSize()
      .toggleable(node.checked, role = if (isSwitch) Role.Switch else Role.Checkbox) {
        interact(OverlayInteraction.Toggle(key, actions))
      }
      .then(modifier),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (!isSwitch) Checkbox(node.checked, onCheckedChange = null)
    if (node.text.isNotEmpty()) OverlayComponentLabel(node)
    if (isSwitch) Switch(node.checked, onCheckedChange = null)
  }
}

/**
 * A filled (default), tonal, elevated, outlined or text Material button, with an optional leading
 * icon, whose tap runs the node's `onTap`.
 */
@Composable
internal fun RenderOverlayButton(
  node: OverlayRenderNode,
  modifier: Modifier,
  interact: (OverlayInteraction) -> Unit,
) {
  val source = node.source as? OverlayButtonNode ?: return
  val actions = source.onTap.orEmpty()
  val onClick = { if (actions.isNotEmpty()) interact(OverlayInteraction.Tap(actions)) }
  val icon = overlayIcon(source.icon)
  val padding =
    if (icon != null) ButtonDefaults.ButtonWithIconContentPadding else ButtonDefaults.ContentPadding
  val content: @Composable RowScope.() -> Unit = {
    if (icon != null) {
      Icon(icon, contentDescription = null, Modifier.size(ButtonDefaults.IconSize))
      Spacer(Modifier.size(ButtonDefaults.IconSpacing))
    }
    OverlayComponentLabel(node)
  }
  when (source.variant) {
    "tonal" -> FilledTonalButton(onClick, modifier, contentPadding = padding, content = content)
    "elevated" -> ElevatedButton(onClick, modifier, contentPadding = padding, content = content)
    "outlined" -> OutlinedButton(onClick, modifier, contentPadding = padding, content = content)
    "text" -> TextButton(onClick, modifier, contentPadding = padding, content = content)
    else -> Button(onClick, modifier, contentPadding = padding, content = content)
  }
}

/** The node-level semantics already carry the label, so the drawn text adds none of its own. */
@Composable
private fun OverlayComponentLabel(node: OverlayRenderNode) {
  Text(
    node.text,
    Modifier.clearAndSetSemantics {},
    color = if (node.style.source.color != null) node.style.color else LocalContentColor.current,
  )
}
