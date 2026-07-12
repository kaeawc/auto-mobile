package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Overlay showing screenshot capture metadata from the observation stream (issue #3757): a
 * fallback-capture warning when the daemon fell back to a slower capture path, and a
 * format/capture-source label. Renders nothing when no metadata is present (older daemons), so it
 * never occupies space or clutters the device screen view.
 */
@Composable
fun ScreenshotMetadataOverlay(
  fallback: Boolean,
  fallbackReason: String?,
  format: String?,
  captureSource: String?,
  modifier: Modifier = Modifier,
) {
  val hasSourceLabel = format != null || captureSource != null
  if (!fallback && !hasSourceLabel) return

  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    if (fallback) {
      ScreenshotFallbackBadge(reason = fallbackReason)
    }
    if (hasSourceLabel) {
      ScreenshotSourceLabel(format = format, captureSource = captureSource)
    }
  }
}

@Composable
private fun ScreenshotFallbackBadge(reason: String?, modifier: Modifier = Modifier) {
  Column(
    modifier =
      modifier
        .background(Color(0xFFFF9800).copy(alpha = 0.85f), RoundedCornerShape(4.dp))
        .padding(horizontal = 6.dp, vertical = 3.dp)
  ) {
    Text(
      text = "Fallback capture",
      color = Color.White,
      fontSize = 10.sp,
      maxLines = 1,
    )
    if (reason != null) {
      Text(
        text = reason,
        color = Color.White.copy(alpha = 0.85f),
        fontSize = 9.sp,
        maxLines = 1,
      )
    }
  }
}

@Composable
private fun ScreenshotSourceLabel(
  format: String?,
  captureSource: String?,
  modifier: Modifier = Modifier,
) {
  val label = listOfNotNull(format, captureSource).joinToString(" · ")
  Row(
    modifier =
      modifier
        .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
        .padding(horizontal = 6.dp, vertical = 3.dp)
  ) {
    Text(
      text = label,
      color = Color.White.copy(alpha = 0.8f),
      fontSize = 9.sp,
      maxLines = 1,
    )
  }
}
