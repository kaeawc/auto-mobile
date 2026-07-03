package dev.jasonpearson.automobile.desktop.core.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Shared search bar component used in View Hierarchy and Telemetry dashboards.
 *
 * @param showRegexToggle When true, shows a "/re/" button to toggle regex mode.
 * @param isRegexEnabled Whether regex mode is currently active (only used when [showRegexToggle] is
 *   true).
 * @param onRegexToggle Called when the regex toggle is clicked (only used when [showRegexToggle] is
 *   true).
 */
@Composable
fun SearchBar(
  query: String,
  onQueryChange: (String) -> Unit,
  placeholder: String = "Search...",
  showRegexToggle: Boolean = false,
  isRegexEnabled: Boolean = false,
  onRegexToggle: (() -> Unit)? = null,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      modifier
        .height(28.dp)
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "\uD83D\uDD0D", // 🔍
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
    Spacer(Modifier.width(6.dp))
    BasicTextField(
      value = query,
      onValueChange = onQueryChange,
      textStyle =
        TextStyle(
          fontSize = 12.sp,
          color = colors.text.normal,
        ),
      cursorBrush = SolidColor(colors.text.normal),
      singleLine = true,
      modifier = Modifier.weight(1f),
      decorationBox = { innerTextField ->
        Box {
          if (query.isEmpty()) {
            Text(
              placeholder,
              fontSize = 12.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
          innerTextField()
        }
      },
    )
    if (showRegexToggle && onRegexToggle != null) {
      Text(
        "/re/",
        fontSize = 10.sp,
        color = if (isRegexEnabled) colors.text.normal else colors.text.normal.copy(alpha = 0.35f),
        modifier =
          Modifier.background(
              if (isRegexEnabled) colors.text.normal.copy(alpha = 0.12f) else Color.Transparent,
              RoundedCornerShape(3.dp),
            )
            .clickable { onRegexToggle() }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 4.dp, vertical = 2.dp),
      )
      Spacer(Modifier.width(4.dp))
    }
    if (query.isNotEmpty()) {
      Text(
        "\u2715", // ✕
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        modifier =
          Modifier.clickable { onQueryChange("") }.pointerHoverIcon(PointerIcon.Hand).padding(4.dp),
      )
    }
  }
}
