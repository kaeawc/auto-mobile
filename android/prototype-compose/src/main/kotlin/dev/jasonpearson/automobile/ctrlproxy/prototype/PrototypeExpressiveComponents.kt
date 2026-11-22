package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeMenuDivider
import dev.jasonpearson.automobile.protocol.PrototypeMenuEntry
import dev.jasonpearson.automobile.protocol.PrototypeMenuItem
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode

/*
 * Material 3 Expressive components (#15258). The pinned Compose BOM's material3 (1.4.0) ships the
 * Expressive tokens but none of these components, so each is drawn from stable primitives. Shape
 * and expansion follow the expressive spatial spring and colour the effects spring from the
 * contract's motion tokens ([prototypeExpressiveSpec]); everything snaps when motion is off.
 * Menus expand inline rather than in a popup, as the renderer never opens popup windows.
 */

/**
 * The expressive spatial spring, snapped under the reduced profile, which keeps colour changes but
 * no spatial motion; [prototypeExpressiveSpec] already snaps when motion is off.
 */
@Composable
internal fun <T> prototypeExpressiveSpatialSpec(): FiniteAnimationSpec<T> =
  if (LocalPrototypeMotionProfile.current == PrototypeMotionProfile.REDUCED) snap()
  else prototypeExpressiveSpec()

/** Inner corner of a connected segment: small at rest, a full pill once selected. */
internal val PROTOTYPE_CONNECTED_INNER_CORNER = 8.dp
internal val PROTOTYPE_CONNECTED_FULL_CORNER = 20.dp
private val CONNECTED_HEIGHT = 40.dp

/** The animated inner corner of one connected segment; outer ends stay fully rounded. */
@Composable
internal fun animatePrototypeConnectedCorner(selected: Boolean): State<Dp> =
  animateDpAsState(
    if (selected) PROTOTYPE_CONNECTED_FULL_CORNER else PROTOTYPE_CONNECTED_INNER_CORNER,
    prototypeExpressiveSpatialSpec(),
    label = "connectedCorner",
  )

private fun connectedShape(index: Int, count: Int, inner: Dp): Shape {
  val full = PROTOTYPE_CONNECTED_FULL_CORNER
  val start = if (index == 0) full else inner
  val end = if (index == count - 1) full else inner
  return RoundedCornerShape(
    topStart = start,
    bottomStart = start,
    topEnd = end,
    bottomEnd = end,
  )
}

/**
 * A connected button group bound to a string key (`segmentedButton` `variant: "connected"`). Each
 * segment is a selectable node tagged `<testTag>.<value>` like a radio option; the selected one
 * morphs its inner corners into a pill and fills with the secondary container colour.
 */
@Composable
internal fun RenderPrototypeConnectedSegments(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSegmentedButtonNode ?: return
  val actions = source.onTap.orEmpty()
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
    source.options.forEachIndexed { index, option ->
      val selected = option.value == node.selectedValue
      val inner by animatePrototypeConnectedCorner(selected)
      val colors = MaterialTheme.colorScheme
      val container by
        animateColorAsState(
          if (selected) colors.secondary else colors.secondaryContainer,
          prototypeExpressiveSpec(effects = true),
          label = "connectedContainer",
        )
      val content = if (selected) colors.onSecondary else colors.onSecondaryContainer
      Surface(
        shape = connectedShape(index, source.options.size, inner),
        color = container,
        contentColor = content,
        modifier =
          Modifier.weight(1f)
            .heightIn(min = CONNECTED_HEIGHT)
            .selectable(selected, role = Role.RadioButton) {
              interact(PrototypeInteraction.Choose(source.stateKey, option.value, actions))
            }
            .semantics {
              contentDescription = option.label
              prototypeRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
            },
      ) {
        Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), Alignment.Center) {
          Text(option.label, Modifier.clearAndSetSemantics {})
        }
      }
    }
  }
}

/** Expansion of a FAB or split-button menu: 0 closed, 1 open, on the expressive spatial spring. */
@Composable
internal fun animatePrototypeMenuExpansion(open: Boolean): State<Float> =
  animateFloatAsState(
    if (open) 1f else 0f,
    prototypeExpressiveSpatialSpec(),
    label = "menuExpansion",
  )

internal fun Modifier.prototypeMenuExpansion(fraction: Float): Modifier = graphicsLayer {
  alpha = fraction.coerceIn(0f, 1f)
  scaleX = 0.6f + 0.4f * fraction
  scaleY = 0.6f + 0.4f * fraction
}

/**
 * A split button (`button.split`): the leading half runs the node's `onTap`, the trailing half
 * (tagged `<testTag>.menu`) opens the menu entries below it and morphs into a circle while open. An
 * entry tap closes the menu, then runs its `onTap`; entries are tagged `<testTag>.menu.<index>`.
 */
@Composable
internal fun RenderPrototypeSplitButton(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeButtonNode ?: return
  val split = source.split ?: return
  var open by remember(node.identity) { mutableStateOf(false) }
  val expansion by animatePrototypeMenuExpansion(open)
  val trailingCorner by
    animateDpAsState(
      if (open) PROTOTYPE_CONNECTED_FULL_CORNER else SPLIT_INNER_CORNER,
      prototypeExpressiveSpatialSpec(),
      label = "splitCorner",
    )
  val actions = source.onTap.orEmpty()
  val full = PROTOTYPE_CONNECTED_FULL_CORNER
  // Parent layout data and the node's semantics stay on the outer layout; each half is labelled.
  Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
      PrototypeVariantButton(
        PrototypeButtonLook(
          source.variant,
          RoundedCornerShape(full, SPLIT_INNER_CORNER, SPLIT_INNER_CORNER, full),
          node.enabled,
        ),
        { if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions)) },
        Modifier.semantics { contentDescription = node.contentDescription ?: node.text },
      ) {
        prototypeIcon(source.icon)?.let {
          Icon(it, contentDescription = null, Modifier.size(ButtonDefaults.IconSize))
          Box(Modifier.size(ButtonDefaults.IconSpacing))
        }
        PrototypeComponentLabel(node)
      }
      PrototypeVariantButton(
        PrototypeButtonLook(
          source.variant,
          RoundedCornerShape(trailingCorner, full, full, trailingCorner),
          node.enabled,
          PaddingValues(12.dp),
        ),
        { open = !open },
        Modifier.semantics {
          contentDescription = if (open) "Close menu" else "Open menu"
          prototypePartTag(node.testTag, "menu")?.let { testTag = it }
        },
      ) {
        prototypeIcon("arrow_drop_down")?.let {
          Icon(it, contentDescription = null, Modifier.rotate(180f * expansion))
        }
      }
    }
    if (open || expansion > 0f) {
      PrototypeSplitMenu(split.menu, node.testTag, SplitMenuState(open, node.enabled), expansion) {
        entry ->
        open = false
        interact(PrototypeInteraction.Tap(entry.onTap.orEmpty()))
      }
    }
  }
}

private val SPLIT_INNER_CORNER = 4.dp

/** Whether the split menu is open, and whether its button is enabled (disabling every entry). */
private data class SplitMenuState(val open: Boolean, val enabled: Boolean)

/** The split button's entries below it, tagged `<testTag>.menu.<index>`; dividers keep an index. */
@Composable
private fun PrototypeSplitMenu(
  menu: List<PrototypeMenuItem>,
  testTag: String?,
  state: SplitMenuState,
  expansion: Float,
  pick: (PrototypeMenuEntry) -> Unit,
) {
  Surface(
    Modifier.prototypeMenuExpansion(expansion).widthIn(min = 112.dp, max = 320.dp),
    shape = MaterialTheme.shapes.medium,
    tonalElevation = 3.dp,
    shadowElevation = 3.dp,
  ) {
    Column(Modifier.padding(vertical = 8.dp)) {
      menu.forEachIndexed { index, item ->
        when (item) {
          PrototypeMenuDivider -> HorizontalDivider()
          is PrototypeMenuEntry -> {
            val enabled = state.enabled && item.enabled != false
            Row(
              Modifier.clickable(enabled = state.open && enabled, role = Role.Button) { pick(item) }
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .alpha(if (enabled) 1f else 0.38f)
                .semantics(mergeDescendants = true) {
                  contentDescription = item.label
                  prototypePartTag(testTag, "menu.$index")?.let { this.testTag = it }
                  if (!enabled) disabled()
                }
                .padding(horizontal = 16.dp),
              horizontalArrangement = Arrangement.spacedBy(12.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              prototypeIcon(item.icon)?.let { Icon(it, contentDescription = null) }
              Text(item.label, Modifier.weight(1f).clearAndSetSemantics {})
              item.trailingText?.let { Text(it) }
            }
          }
        }
      }
    }
  }
}

/** How one half of a split button draws: its Material variant, shape, enabled state and padding. */
private data class PrototypeButtonLook(
  val variant: String,
  val shape: Shape,
  val enabled: Boolean,
  val padding: PaddingValues = ButtonDefaults.ContentPadding,
)

@Composable
private fun PrototypeVariantButton(
  look: PrototypeButtonLook,
  onClick: () -> Unit,
  modifier: Modifier,
  content: @Composable RowScope.() -> Unit,
) {
  val (variant, shape, enabled, padding) = look
  when (variant) {
    "tonal" ->
      FilledTonalButton(
        onClick,
        modifier,
        enabled,
        shape,
        contentPadding = padding,
        content = content,
      )
    "elevated" ->
      ElevatedButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    "outlined" ->
      OutlinedButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    "text" ->
      TextButton(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
    else -> Button(onClick, modifier, enabled, shape, contentPadding = padding, content = content)
  }
}
