package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.clipboard.LocalClipboardWriter
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Property inspector panel showing details of the selected UI element. Displays:
 * - Identity (class, resource ID, content description)
 * - Bounds (position, size)
 * - State (clickable, enabled, focused, etc.)
 * - Text content
 */
@Composable
fun PropertyInspectorPanel(
  element: UIElementInfo?,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val verticalScrollState = rememberScrollState()
  val horizontalScrollState = rememberScrollState()

  Box(modifier = modifier.fillMaxSize().horizontalScroll(horizontalScrollState)) {
    Column(
      modifier = Modifier.widthIn(min = 180.dp).verticalScroll(verticalScrollState).padding(12.dp),
    ) {
      if (element == null) {
        Box(
          modifier = Modifier.fillMaxSize(),
          contentAlignment = Alignment.Center,
        ) {
          Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
          ) {
            Text(
              "No element selected",
              color = colors.text.normal.copy(alpha = 0.5f),
              fontSize = 12.sp,
            )
            Text(
              "Click on the screen or tree to select",
              color = colors.text.normal.copy(alpha = 0.3f),
              fontSize = 11.sp,
            )
          }
        }
      } else {
        ElementProperties(element)
      }
    }
  }
}

@Composable
internal fun PropertySection(
  title: String,
  content: @Composable () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(modifier = Modifier.fillMaxWidth()) {
    Text(
      title,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.7f),
      maxLines = 1,
      softWrap = false,
    )
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .padding(top = 2.dp, bottom = 4.dp)
          .height(1.dp)
          .background(colors.text.normal.copy(alpha = 0.1f)),
    )
    Column(
      verticalArrangement = Arrangement.spacedBy(4.dp),
      modifier = Modifier.padding(top = 4.dp),
    ) {
      content()
    }
  }
}

@Composable
internal fun PropertyRow(
  label: String,
  value: String,
  isSecondary: Boolean = false,
) {
  val colors = SharedTheme.globalColors
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()
  val clipboard = LocalClipboardWriter.current

  Row(
    modifier = Modifier.fillMaxWidth().hoverable(interactionSource),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = if (isSecondary) 0.4f else 0.6f),
      maxLines = 1,
      softWrap = false,
      modifier = Modifier.width(80.dp),
    )
    Text(
      value,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = if (isSecondary) 0.6f else 1f),
      maxLines = 1,
      softWrap = false,
    )
    if (isHovered) {
      Box(
        modifier =
          Modifier.padding(start = 4.dp)
            .clickable { clipboard.writeText(value) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(2.dp),
      ) {
        Text("📋", fontSize = 9.sp) // clipboard icon
      }
    }
  }
}

/**
 * Copies an automation-ready selector for [element] (see [buildElementSelector]) to the clipboard.
 * Gives the property inspector the same "copy selector" affordance as the hierarchy tree (#5205).
 */
@Composable
internal fun CopySelectorButton(element: UIElementInfo) {
  val colors = SharedTheme.globalColors
  val clipboard = LocalClipboardWriter.current
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .clip(RoundedCornerShape(4.dp))
        .background(colors.text.normal.copy(alpha = 0.08f))
        .clickable { clipboard.copyElementSelector(element) }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 4.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text("📋", fontSize = 10.sp) // clipboard icon
    Text(
      "Copy selector",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.8f),
      maxLines = 1,
      softWrap = false,
    )
  }
}

@Composable
internal fun StateCheckbox(
  label: String,
  isChecked: Boolean,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      maxLines = 1,
      softWrap = false,
    )
    Box(
      modifier =
        Modifier.size(14.dp)
          .clip(RoundedCornerShape(3.dp))
          .background(
            if (isChecked) Color(0xFF4CAF50).copy(alpha = 0.2f)
            else colors.text.normal.copy(alpha = 0.05f),
          ),
      contentAlignment = Alignment.Center,
    ) {
      if (isChecked) {
        Text(
          "\u2713", // Checkmark
          fontSize = 10.sp,
          color = Color(0xFF4CAF50),
        )
      }
    }
  }
}
