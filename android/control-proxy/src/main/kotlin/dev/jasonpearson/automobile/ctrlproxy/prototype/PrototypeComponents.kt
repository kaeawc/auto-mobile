package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCardNode
import dev.jasonpearson.automobile.protocol.PrototypeCheckboxNode
import dev.jasonpearson.automobile.protocol.PrototypeChipNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeSliderNode
import dev.jasonpearson.automobile.protocol.PrototypeSwitchNode

/**
 * Material 3 component nodes (#10439). Each draws its own Material control and owns its tap, so
 * [prototypeNodeModifier] must not add a second click handler for these roles.
 */
internal val PROTOTYPE_COMPONENT_ROLES = setOf("switch", "checkbox", "button", "slider", "chip")

/**
 * The boolean state key a `switch`, `checkbox` or filter `chip` is bound to; null for every other
 * node, including an assist chip.
 */
internal fun prototypeToggleKey(node: PrototypeNode): String? =
  when (node) {
    is PrototypeSwitchNode -> node.stateKey
    is PrototypeCheckboxNode -> node.stateKey
    is PrototypeChipNode -> node.stateKey
    else -> null
  }

/**
 * A labelled switch or checkbox. The whole row is one toggleable target carrying the Switch or
 * Checkbox role and its checked state, so observe reports `checkable`/`checked` and tapOn by
 * `testTag` toggles it. The inner Material control is display-only (`onCheckedChange = null`).
 */
@Composable
internal fun RenderPrototypeToggle(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source ?: return
  val key = prototypeToggleKey(source) ?: return
  val actions = source.onTap.orEmpty()
  val isSwitch = node.role == "switch"
  Row(
    Modifier.minimumInteractiveComponentSize()
      .toggleable(node.checked, role = if (isSwitch) Role.Switch else Role.Checkbox) {
        interact(PrototypeInteraction.Toggle(key, actions))
      }
      .then(modifier),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (!isSwitch) Checkbox(node.checked, onCheckedChange = null)
    if (node.text.isNotEmpty()) PrototypeComponentLabel(node)
    if (isSwitch) Switch(node.checked, onCheckedChange = null)
  }
}

/**
 * A filled (default), tonal, elevated, outlined or text Material button, with an optional leading
 * icon, whose tap runs the node's `onTap`.
 */
@Composable
internal fun RenderPrototypeButton(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeButtonNode ?: return
  val actions = source.onTap.orEmpty()
  val onClick = { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) }
  val icon = prototypeIcon(source.icon)
  val padding =
    if (icon != null) ButtonDefaults.ButtonWithIconContentPadding else ButtonDefaults.ContentPadding
  val content: @Composable RowScope.() -> Unit = {
    if (icon != null) {
      Icon(
        icon,
        contentDescription = null,
        Modifier.size(ButtonDefaults.IconSize),
        tint = prototypeForeground(node),
      )
      Spacer(Modifier.size(ButtonDefaults.IconSpacing))
    }
    PrototypeComponentLabel(node)
  }
  when (source.variant) {
    "tonal" -> FilledTonalButton(onClick, modifier, contentPadding = padding, content = content)
    "elevated" -> ElevatedButton(onClick, modifier, contentPadding = padding, content = content)
    "outlined" -> OutlinedButton(onClick, modifier, contentPadding = padding, content = content)
    "text" -> TextButton(onClick, modifier, contentPadding = padding, content = content)
    else ->
      // An authored gradient is painted behind the button, so its container must not cover it.
      Button(
        onClick,
        modifier,
        colors =
          if (node.style.source.gradient != null)
            ButtonDefaults.buttonColors(containerColor = Color.Transparent)
          else ButtonDefaults.buttonColors(),
        contentPadding = padding,
        content = content,
      )
  }
}

/** The authored `style.color` when set, else the enclosing Material component's content color. */
@Composable
internal fun prototypeForeground(node: PrototypeRenderNode): Color =
  prototypeThemedColor(null, node.style.source.color) ?: LocalContentColor.current

/** The node-level semantics already carry the label, so the drawn text adds none of its own. */
@Composable
private fun PrototypeComponentLabel(node: PrototypeRenderNode) {
  Text(
    node.text,
    Modifier.clearAndSetSemantics {},
    color = prototypeForeground(node),
  )
}

/** The step-aligned, in-range value a drag or set-progress lands on, rounded to micro-units. */
internal fun snapPrototypeSlider(raw: Double, min: Double, max: Double, step: Double?): Double {
  val clamped = raw.coerceIn(min, max)
  if (step == null) return clamped
  val snapped = min + Math.round((clamped - min) / step) * step
  return (Math.round(snapped * 1e6) / 1e6).coerceIn(min, max)
}

/** Compose counts the discrete positions strictly between the ends. */
internal fun prototypeSliderSteps(min: Double, max: Double, step: Double?): Int =
  if (step == null) 0 else (Math.round((max - min) / step).toInt() - 1).coerceAtLeast(0)

/**
 * A labelled Material slider bound to a number. Material's Slider supplies the progress range info
 * and set-progress action; merging them into the node's own semantics keeps one accessibility node
 * whose value observe reads from the range info.
 */
@Composable
internal fun RenderPrototypeSlider(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSliderNode ?: return
  val actions = source.onTap.orEmpty()
  val range = source.min.toFloat()..source.max.toFloat()
  val steps = prototypeSliderSteps(source.min, source.max, source.step)
  val change = { raw: Float ->
    val value = snapPrototypeSlider(raw.toDouble(), source.min, source.max, source.step)
    interact(PrototypeInteraction.Slide(source.stateKey, value, actions))
  }
  Column(
    modifier.semantics(mergeDescendants = true) {
      progressBarRangeInfo = ProgressBarRangeInfo(node.sliderValue.toFloat(), range, steps)
      setProgress {
        change(it)
        true
      }
    },
  ) {
    if (node.text.isNotEmpty()) PrototypeComponentLabel(node)
    Slider(
      node.sliderValue.toFloat(),
      change,
      Modifier.fillMaxWidth(),
      valueRange = range,
      steps = steps,
    )
  }
}

/**
 * An assist chip (no `stateKey`) runs `onTap`; a filter chip toggles its boolean key like a switch
 * and exposes the Checkbox role with its checked state.
 */
@Composable
internal fun RenderPrototypeChip(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeChipNode ?: return
  val actions = source.onTap.orEmpty()
  val key = source.stateKey
  if (key == null) {
    AssistChip(
      { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) },
      { PrototypeComponentLabel(node) },
      modifier,
    )
    return
  }
  val colors = MaterialTheme.colorScheme
  Row(
    Modifier.minimumInteractiveComponentSize()
      .toggleable(node.checked, role = Role.Checkbox) {
        interact(PrototypeInteraction.Toggle(key, actions))
      }
      .then(modifier),
  ) {
    Surface(
      shape = FilterChipDefaults.shape,
      color = if (node.checked) colors.secondaryContainer else Color.Transparent,
      contentColor = if (node.checked) colors.onSecondaryContainer else colors.onSurfaceVariant,
      border = if (node.checked) null else BorderStroke(1.dp, colors.outlineVariant),
    ) {
      Row(
        Modifier.height(FilterChipDefaults.Height).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        if (node.checked) Icon(Icons.Default.Check, null, Modifier.size(18.dp))
        ProvideTextStyle(MaterialTheme.typography.labelLarge) { PrototypeComponentLabel(node) }
      }
    }
  }
}

/** A filled (default), elevated or outlined Material card holding the node's children. */
@Composable
internal fun RenderPrototypeCard(
  node: PrototypeRenderNode,
  modifier: Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  val container = prototypeThemedColor(node.style.background, node.style.source.background)
  when ((node.source as? PrototypeCardNode)?.variant) {
    "elevated" ->
      ElevatedCard(
        modifier,
        colors =
          container?.let { CardDefaults.elevatedCardColors(containerColor = it) }
            ?: CardDefaults.elevatedCardColors(),
        content = content,
      )
    "outlined" ->
      OutlinedCard(
        modifier,
        colors =
          container?.let { CardDefaults.outlinedCardColors(containerColor = it) }
            ?: CardDefaults.outlinedCardColors(),
        content = content,
      )
    else ->
      Card(
        modifier,
        colors =
          container?.let { CardDefaults.cardColors(containerColor = it) }
            ?: CardDefaults.cardColors(),
        content = content,
      )
  }
}
