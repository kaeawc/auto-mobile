package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import java.text.SimpleDateFormat

data class TelemetryDetailOptions(
  val event: TelemetryDisplayEvent,
  val timeFormat: SimpleDateFormat,
  val textColor: Color,
  val onClose: () -> Unit,
  val onOpenSource: ((String, Int, String) -> Unit)? = null,
  val screenshotLoader: ScreenshotLoader? = null,
  val modifier: Modifier = Modifier,
)
