package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
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

/**
 * Non-blocking error banner for a failed device-control tap (issue #3347). Surfaces the daemon's
 * actionable error message returned by the `input/tap` helper so a failed tap is visible without
 * crashing the live layout view. Click the banner to dismiss it.
 */
@Composable
fun DeviceControlTapErrorBanner(
  message: String,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Row(
    modifier =
      modifier
        .background(Color(0xFFD32F2F).copy(alpha = 0.9f), RoundedCornerShape(6.dp))
        .clickable(onClick = onDismiss)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      text = "Tap failed: $message",
      color = Color.White,
      fontSize = 11.sp,
    )
    Text(
      text = "✕", // ✕ dismiss
      color = Color.White.copy(alpha = 0.8f),
      fontSize = 11.sp,
    )
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
