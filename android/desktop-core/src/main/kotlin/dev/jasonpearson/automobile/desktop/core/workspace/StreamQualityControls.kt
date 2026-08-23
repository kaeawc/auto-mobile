package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import kotlin.math.roundToInt

/**
 * Compact quality overlay for a live-mirror pane: a Low/Medium/High selector, the
 * measured-vs-target frame rate, the current preset, and an auto-adjust toggle. It is a pure view —
 * all state and the [onSelectQuality]/[onToggleAutoAdjust] callbacks are hoisted, so the pane owns
 * the [QualityController] and persistence and this composable stays trivially testable.
 *
 * @param actualFps the live rate from the controller; rendered rounded next to [targetFps].
 */
@Composable
fun StreamQualityControls(
  currentQuality: VideoStreamQuality,
  actualFps: Float,
  targetFps: Int,
  autoAdjustEnabled: Boolean,
  onSelectQuality: (VideoStreamQuality) -> Unit,
  onToggleAutoAdjust: (Boolean) -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier =
      modifier
        .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(6.dp))
        .padding(horizontal = 8.dp, vertical = 6.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(
      "${actualFps.roundToInt()} / $targetFps fps",
      fontSize = 10.sp,
      color = Color.White.copy(alpha = 0.9f),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      VideoStreamQuality.entries.forEach { quality ->
        val selected = quality == currentQuality
        Chip(
          label = quality.name,
          accent = if (selected) SELECTED_ACCENT else UNSELECTED_ACCENT,
          onClick = { onSelectQuality(quality) },
        )
      }
      Chip(
        label = "Auto",
        accent = if (autoAdjustEnabled) SELECTED_ACCENT else UNSELECTED_ACCENT,
        onClick = { onToggleAutoAdjust(!autoAdjustEnabled) },
      )
    }
  }
}

private val SELECTED_ACCENT = Color(0xFF4CAF50)
private val UNSELECTED_ACCENT = Color(0xFF9E9E9E)

@Composable
private fun Chip(label: String, accent: Color, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.background(accent.copy(alpha = 0.25f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 3.dp)
  ) {
    Text(label, fontSize = 9.sp, color = Color.White.copy(alpha = 0.95f))
  }
}
