package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.clipboard.LocalClipboardWriter
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DetailRow(label: String, value: String, textColor: Color) {
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()
  val clipboard = LocalClipboardWriter.current

  Row(
    modifier = Modifier.fillMaxWidth().hoverable(interactionSource).padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.5f),
      modifier = Modifier.padding(end = 4.dp),
    )
    Text(
      value,
      fontSize = 10.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.85f),
      modifier = Modifier.weight(1f),
    )
    if (isHovered) {
      Box(
        modifier =
          Modifier.clickable { clipboard.writeText(value) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(2.dp),
      ) {
        Text("\uD83D\uDCCB", fontSize = 9.sp) // 📋
      }
    }
  }
}

@Composable
internal fun HeaderIconButton(
  icon: String,
  textColor: Color,
  focusedBorderColor: Color,
  onClick: () -> Unit,
) {
  var isFocused by remember { mutableStateOf(false) }
  Box(
    modifier =
      Modifier.onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier,
        )
        .background(textColor.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .clickable { onClick() }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 2.dp),
  ) {
    Text(icon, fontSize = 11.sp, color = textColor.copy(alpha = 0.6f))
  }
}

@Composable
internal fun CollapsibleSection(
  title: String,
  textColor: Color,
  defaultExpanded: Boolean = true,
  copyText: String? = null,
  content: @Composable () -> Unit,
) {
  val focusedBorderColor = SharedTheme.globalColors.outlines.focused
  val clipboard = LocalClipboardWriter.current
  var expanded by remember { mutableStateOf(defaultExpanded) }
  var isFocused by remember { mutableStateOf(false) }
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier,
        )
        .clickable { expanded = !expanded }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      if (expanded) "\u25BE" else "\u25B8",
      fontSize = 9.sp,
      color = textColor.copy(alpha = 0.5f),
    )
    Spacer(Modifier.width(4.dp))
    Text(
      title,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.7f),
      modifier = Modifier.weight(1f),
    )
    if (copyText != null && expanded) {
      var copyIsFocused by remember { mutableStateOf(false) }
      Box(
        modifier =
          Modifier.onFocusChanged { copyIsFocused = it.isFocused }
            .then(
              if (copyIsFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
              else Modifier,
            )
            .clickable { clipboard.writeText(copyText) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(4.dp),
      ) {
        Text("\uD83D\uDCCB", fontSize = 10.sp) // clipboard icon
      }
    }
  }
  if (expanded) {
    content()
  }
}

@Composable
internal fun MonospaceBlock(text: String, textColor: Color) {
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .padding(6.dp),
  ) {
    Text(
      text,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.8f),
    )
  }
}

@Composable
internal fun SyntaxHighlightedJson(json: String, textColor: Color) {
  val annotated = remember(json, textColor) { buildSyntaxHighlightedJson(json, textColor) }
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .padding(6.dp),
  ) {
    Text(
      annotated,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

@Composable
internal fun ActionButton(
  label: String,
  textColor: Color,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  val focusedBorderColor = SharedTheme.globalColors.outlines.focused
  var isFocused by remember { mutableStateOf(false) }
  Box(
    modifier =
      Modifier.onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier,
        )
        .background(
          if (enabled) textColor.copy(alpha = 0.12f) else textColor.copy(alpha = 0.05f),
          RoundedCornerShape(4.dp),
        )
        .then(
          if (enabled) Modifier.clickable { onClick() }.pointerHoverIcon(PointerIcon.Hand)
          else Modifier,
        )
        .padding(horizontal = 10.dp, vertical = 4.dp),
  ) {
    Text(
      label,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = if (enabled) textColor.copy(alpha = 0.8f) else textColor.copy(alpha = 0.4f),
    )
  }
}
