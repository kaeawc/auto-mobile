package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDetailPanel
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Locale

/** Renders full detail for a selected telemetry event by delegating to [TelemetryDetailPanel]. */
@Composable
fun EventInspectorContent(
    event: TelemetryDisplayEvent,
    onClose: () -> Unit,
    onOpenSource: ((String, Int, String) -> Unit)? = null,
    screenshotLoader: ScreenshotLoader? = null,
    modifier: Modifier = Modifier,
) {
  val timeFormat = remember { SimpleDateFormat("HH:mm:ss.SSS", Locale.US) }
  val textColor = SharedTheme.globalColors.text.normal

  TelemetryDetailPanel(
      event = event,
      timeFormat = timeFormat,
      textColor = textColor,
      onClose = onClose,
      onOpenSource = onOpenSource,
      screenshotLoader = screenshotLoader,
      modifier = modifier,
  )
}

/**
 * Horizontal tab bar for switching between detail sub-views (e.g. Network
 * Overview/Headers/Request/Response or Failure Summary/Stack Trace).
 */
@Composable
fun InspectorTabBar(
    tabs: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    textColor: Color = SharedTheme.globalColors.text.normal,
    focusedBorderColor: Color = SharedTheme.globalColors.outlines.focused,
) {
  Row(
      modifier = Modifier.padding(bottom = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(2.dp),
      verticalAlignment = Alignment.CenterVertically,
  ) {
    tabs.forEachIndexed { index, label ->
      val isSelected = index == selected
      var isFocused by remember { mutableStateOf(false) }
      Box(
          modifier =
              Modifier.onFocusChanged { isFocused = it.isFocused }
                  .then(
                      if (isFocused)
                          Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
                      else Modifier
                  )
                  .background(
                      if (isSelected) textColor.copy(alpha = 0.12f) else Color.Transparent,
                      RoundedCornerShape(4.dp),
                  )
                  .clickable { onSelect(index) }
                  .pointerHoverIcon(PointerIcon.Hand)
                  .padding(horizontal = 8.dp, vertical = 4.dp),
      ) {
        Text(
            label,
            fontSize = 10.sp,
            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (isSelected) textColor else textColor.copy(alpha = 0.5f),
        )
      }
    }
  }
}
