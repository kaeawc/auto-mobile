@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.clipboard.LocalClipboardWriter
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

internal data class TreeNodeOptions(
  val isSelected: Boolean,
  val isHovered: Boolean,
  val isInSelectedPath: Boolean,
  val onToggleExpand: () -> Unit,
  val onSelect: () -> Unit,
  val onDoubleClick: () -> Unit,
  val onHoverChange: (Boolean) -> Unit,
)

@Composable
internal fun TreeNodeRow(node: FlatTreeNode, options: TreeNodeOptions) {
  // Row-level hover state for showing copy button
  val rowInteractionSource = remember { MutableInteractionSource() }
  val isRowHovered by rowInteractionSource.collectIsHoveredAsState()

  Row(
    modifier =
      Modifier.widthIn(min = 200.dp) // Minimum width to ensure content doesn't wrap
        .heightIn(min = 18.dp) // Minimum tap target height
        .background(treeNodeBackground(node, options))
        .hoverable(rowInteractionSource)
        .pointerInput(Unit) {
          detectTapGestures(
            onTap = { options.onSelect() },
            onDoubleTap = { options.onDoubleClick() },
          )
        }
        .onPointerEvent(PointerEventType.Enter) { options.onHoverChange(true) }
        .onPointerEvent(PointerEventType.Exit) { options.onHoverChange(false) }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(vertical = 4.dp, horizontal = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Indentation
    Spacer(Modifier.width((node.depth * 16).dp))

    TreeNodeChevron(node, options.onToggleExpand)

    Spacer(Modifier.width(4.dp))

    // Element icon based on type
    ElementIcon(className = node.element.className)

    Spacer(Modifier.width(6.dp))

    TreeNodeLabel(node.element, options.isSelected)

    Spacer(Modifier.width(8.dp))

    TreeNodeIndicators(node.element)

    if (isRowHovered) TreeNodeCopySelector(node.element)

    // Right padding
    Spacer(Modifier.width(8.dp))
  }
}

@Composable
private fun treeNodeBackground(node: FlatTreeNode, options: TreeNodeOptions): Color {
  val colors = SharedTheme.globalColors
  // Per-frame diff accent (issue #3758): tint added/changed nodes so live changes
  // are visible in the tree. Selection/hover take priority; unmarked nodes render
  // transparently, so hierarchies without diff metadata look unchanged.
  val diffColor = diffAccentColor(node.element.diffState)
  return when {
    options.isSelected -> Color(0xFF2196F3).copy(alpha = 0.2f)
    options.isHovered -> colors.text.normal.copy(alpha = 0.08f)
    diffColor != null -> diffColor.copy(alpha = 0.14f)
    options.isInSelectedPath -> colors.text.normal.copy(alpha = 0.04f)
    else -> Color.Transparent
  }
}

@Composable
private fun TreeNodeChevron(node: FlatTreeNode, onToggleExpand: () -> Unit) {
  val colors = SharedTheme.globalColors
  // Expand/collapse chevron
  Box(
    modifier =
      Modifier.size(18.dp)
        .then(
          if (node.hasChildren)
            Modifier.clickable(onClick = onToggleExpand).pointerHoverIcon(PointerIcon.Hand)
          else Modifier,
        ),
    contentAlignment = Alignment.Center,
  ) {
    if (node.hasChildren) {
      Text(
        if (node.isExpanded) "\u25BC" else "\u25B6", // Down/right triangle
        fontSize = 8.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        maxLines = 1,
      )
    }
  }
}

@Composable
private fun TreeNodeLabel(element: UIElementInfo, isSelected: Boolean) {
  val colors = SharedTheme.globalColors
  // Class name (simplified)
  Text(
    getSimpleClassName(element.className),
    fontSize = 11.sp,
    color = if (isSelected) Color(0xFF2196F3) else colors.text.normal,
    maxLines = 1,
    softWrap = false,
  )

  // Resource ID if present
  element.resourceId?.let { resId ->
    val simpleName = resId.substringAfterLast("/")
    Spacer(Modifier.width(4.dp))
    Text(
      "@$simpleName",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      maxLines = 1,
      softWrap = false,
    )
  }

  // Text content preview if present
  element.text
    ?.takeIf { it.isNotEmpty() }
    ?.let { text ->
      Spacer(Modifier.width(4.dp))
      Text(
        "\"${text.take(30)}${if (text.length > 30) "..." else ""}\"",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        maxLines = 1,
        softWrap = false,
      )
    }
}

@Composable
private fun TreeNodeIndicators(element: UIElementInfo) {
  // State indicators
  Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
    if (element.isClickable) {
      StateIndicator("\u261B", "Clickable") // Pointing hand
    }
    if (element.isFocused) {
      StateIndicator("\u25CE", "Focused") // Bullseye
    }
    if (element.isScrollable) {
      StateIndicator("\u2195", "Scrollable") // Up-down arrow
    }
    element.diffState?.let { state ->
      StateIndicator(
        icon = if (state == NodeDiffState.Added) "+" else "\u25CF",
        tooltip =
          if (state == NodeDiffState.Added) "Added since last frame"
          else "Changed since last frame",
        color = diffAccentColor(state),
      )
    }
  }
}

@Composable
private fun TreeNodeCopySelector(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  val selector = remember(element) { buildElementSelector(element) }
  val clipboard = LocalClipboardWriter.current
  Box(
    modifier =
      Modifier.size(24.dp)
        .clickable { clipboard.writeText(selector) }
        .pointerHoverIcon(PointerIcon.Hand),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      "\uD83D\uDCCB", // 📋
      fontSize = 9.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}

@Composable
private fun ElementIcon(className: String) {
  val colors = SharedTheme.globalColors

  val (icon, color) =
    ELEMENT_ICONS.firstOrNull { choice ->
        choice.classNames.any { className.contains(it) }
      }
      ?.let { it.icon to it.color } ?: ("\u25A1" to colors.text.normal.copy(alpha = 0.5f))

  Text(
    icon,
    fontSize = 12.sp,
    color = color,
  )
}

private data class ElementIconChoice(
  val classNames: List<String>,
  val icon: String,
  val color: Color,
)

private val ELEMENT_ICONS =
  listOf(
    ElementIconChoice(listOf("Button"), "\u25A3", Color(0xFF4CAF50)),
    ElementIconChoice(listOf("TextView", "Text"), "T", Color(0xFF2196F3)),
    ElementIconChoice(listOf("EditText", "TextField"), "\u270E", Color(0xFFFFC107)),
    ElementIconChoice(listOf("ImageView", "Image"), "\u25A1", Color(0xFF9C27B0)),
    ElementIconChoice(listOf("RecyclerView", "ListView"), "\u2261", Color(0xFFFF5722)),
    ElementIconChoice(listOf("Layout", "ViewGroup"), "\u25A2", Color(0xFF607D8B)),
    ElementIconChoice(listOf("Toolbar"), "\u2630", Color(0xFF795548)),
    ElementIconChoice(listOf("CheckBox"), "\u2611", Color(0xFF4CAF50)),
    ElementIconChoice(listOf("Switch"), "\u25C9", Color(0xFF4CAF50)),
  )

@Composable
private fun StateIndicator(icon: String, tooltip: String, color: Color? = null) {
  val colors = SharedTheme.globalColors

  Text(
    icon,
    fontSize = 9.sp,
    color = color ?: colors.text.normal.copy(alpha = 0.4f),
  )
}

/** Accent color for a node's diff state, or null when the node is unchanged/unmarked. */
private fun diffAccentColor(state: NodeDiffState?): Color? =
  when (state) {
    NodeDiffState.Added -> Color(0xFF4CAF50)
    NodeDiffState.Changed -> Color(0xFFFFC107)
    null -> null
  }

private fun getSimpleClassName(fullName: String): String {
  return fullName.substringAfterLast(".")
}
