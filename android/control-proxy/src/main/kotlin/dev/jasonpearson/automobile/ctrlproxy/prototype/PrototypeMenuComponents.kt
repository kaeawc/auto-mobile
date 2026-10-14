package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*

/** Window-local measurements and transient select expansion; never part of the spec state. */
internal class PrototypeMenuLayers {
  val bounds = mutableStateMapOf<String, Rect>()
  var windowBounds by mutableStateOf(Rect.Zero)
  var expandedSelect by mutableStateOf<String?>(null)
}

internal val LocalPrototypeMenuLayers = compositionLocalOf { PrototypeMenuLayers() }

/** The parent, rather than the trigger sibling, anchors each menu. Root menus use the window. */
internal fun prototypeMenuParents(root: PrototypeRenderNode): Map<String, String> = buildMap {
  fun visit(node: PrototypeRenderNode) {
    node.children.forEach { child ->
      if (child.role == "menu") put(child.identity, node.identity)
      visit(child)
    }
  }
  visit(root)
}

internal fun Modifier.prototypeMenuBounds(identity: String, layers: PrototypeMenuLayers): Modifier =
  onGloballyPositioned { coordinates ->
    layers.bounds[identity] = coordinates.boundsInRoot()
  }

/** A measured surface aligned to bottom-end, with both axes clamped inside this window. */
@Composable
private fun PrototypeMenuSurface(
  anchor: Rect,
  layers: PrototypeMenuLayers,
  modifier: Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  val direction = LocalLayoutDirection.current
  Layout(
    content = {
      Surface(
        modifier.widthIn(min = 112.dp, max = 320.dp),
        shape = MaterialTheme.shapes.extraSmall,
        tonalElevation = 3.dp,
        shadowElevation = 3.dp,
      ) {
        Column(
          Modifier.verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
          content = content,
        )
      }
    },
    modifier = Modifier.fillMaxSize(),
  ) { measurables, constraints ->
    val surface = measurables.single().measure(constraints.copy(minWidth = 0, minHeight = 0))
    val end = if (direction == LayoutDirection.Rtl) anchor.left else anchor.right - surface.width
    val x =
      (end - layers.windowBounds.left)
        .toInt()
        .coerceIn(0, (constraints.maxWidth - surface.width).coerceAtLeast(0))
    val y =
      (anchor.bottom - layers.windowBounds.top)
        .toInt()
        .coerceIn(0, (constraints.maxHeight - surface.height).coerceAtLeast(0))
    layout(constraints.maxWidth, constraints.maxHeight) { surface.place(x, y) }
  }
}

@Composable
internal fun RenderPrototypeMenu(
  node: PrototypeRenderNode,
  modifier: Modifier,
  anchor: Rect,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeMenuNode ?: return
  if (!node.sheetOpen) return
  val layers = LocalPrototypeMenuLayers.current
  Box(Modifier.fillMaxSize()) {
    Box(
      Modifier.fillMaxSize()
        .clickable { interact(PrototypeInteraction.SheetDismiss(source.openWhen)) }
        .semantics { node.testTag?.let { testTag = "$it:outside" } },
    )
    PrototypeMenuSurface(anchor, layers, modifier.pointerInput(Unit) { detectTapGestures {} }) {
      source.items.forEachIndexed { index, item ->
        when (item) {
          PrototypeMenuDivider -> HorizontalDivider()
          is PrototypeMenuEntry -> {
            val enabled = item.enabled != false
            val click =
              if (enabled)
                Modifier.clickable(role = Role.Button) {
                  interact(PrototypeInteraction.CloseModal(source.openWhen, item.onTap.orEmpty()))
                }
              else Modifier
            Row(
              click
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .alpha(if (enabled) 1f else 0.38f)
                .semantics(mergeDescendants = true) {
                  text = AnnotatedString(item.label)
                  prototypePartTag(node.testTag, index.toString())?.let { testTag = it }
                  if (!enabled) disabled()
                }
                .padding(horizontal = 16.dp),
              horizontalArrangement = Arrangement.spacedBy(12.dp),
              verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
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

@Composable
internal fun RenderPrototypeSelectOptions(
  node: PrototypeRenderNode,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as? PrototypeSelectNode ?: return
  val layers = LocalPrototypeMenuLayers.current
  Box(Modifier.fillMaxSize()) {
    Box(
      Modifier.fillMaxSize()
        .clickable { layers.expandedSelect = null }
        .semantics { node.testTag?.let { testTag = "$it:outside" } },
    )
    PrototypeMenuSurface(layers.bounds[node.identity] ?: layers.windowBounds, layers, Modifier) {
      source.options.forEach { option ->
        Row(
          Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button) {
              layers.expandedSelect = null
              interact(
                PrototypeInteraction.Choose(source.stateKey, option.value, source.onTap.orEmpty()),
              )
            }
            .semantics {
              text = AnnotatedString(option.label)
              selected = option.value == node.selectedValue
              prototypeRadioOptionTag(node.testTag, option.value)?.let { testTag = it }
            }
            .padding(horizontal = 16.dp),
          verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
          Text(option.label, Modifier.clearAndSetSemantics {})
        }
      }
    }
  }
}

/** Only an actually shown field keeps its transient list open. */
internal fun visiblePrototypeSelect(
  node: PrototypeRenderNode,
  identity: String,
): PrototypeRenderNode? {
  if (!node.visible || (node.role in PROTOTYPE_MODAL_ROLES && !node.sheetOpen)) return null
  if (node.role == "select" && node.identity == identity) return node
  val children =
    if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
  return children.firstNotNullOfOrNull { visiblePrototypeSelect(it, identity) }
}
