package dev.jasonpearson.automobile.mediaplayer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import java.util.Locale

data class MediaControlsState(val isPlaying: Boolean, val currentTime: Float, val volume: Float)

/** Media controls overlay with play/pause, seek, and volume controls. */
@Composable
fun MediaControlsOverlay(
  state: MediaControlsState,
  onPlayPause: () -> Unit,
  onSeek: (Float) -> Unit,
  onVolumeChange: (Float) -> Unit,
) {
  val (isPlaying, currentTime, volume) = state
  Column(
    modifier = Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.7f)).padding(16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    MediaSeekControl(currentTime, onSeek)

    // Control buttons
    Row(
      horizontalArrangement = Arrangement.spacedBy(24.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      MediaVolumeControl(volume, onVolumeChange)

      // Play/Pause button
      AutoMobileContentButton(
        onClick = onPlayPause,
        modifier = Modifier.size(64.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
      ) {
        Icon(
          imageVector = if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
          contentDescription = if (isPlaying) "Pause" else "Play",
          tint = Color.White,
        )
      }
    }
  }
}

@Composable
private fun MediaSeekControl(currentTime: Float, onSeek: (Float) -> Unit) {
  // Progress slider
  Column {
    Text(
      text = "${formatTime(currentTime)} / ${formatTime(100f)}",
      color = Color.White,
      fontSize = 14.sp,
    )
    Slider(
      value = currentTime,
      onValueChange = onSeek,
      valueRange = 0f..100f,
      modifier = Modifier.fillMaxWidth(),
      colors =
        SliderDefaults.colors(
          thumbColor = MaterialTheme.colorScheme.primary,
          activeTrackColor = MaterialTheme.colorScheme.primary,
          inactiveTrackColor = Color.Gray,
        ),
    )
  }
}

@Composable
private fun MediaVolumeControl(volume: Float, onVolumeChange: (Float) -> Unit) {
  // Volume control
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      imageVector = Icons.AutoMirrored.Filled.VolumeUp,
      contentDescription = "Volume Up",
      tint = Color.White,
    )
    Slider(
      value = volume,
      onValueChange = onVolumeChange,
      valueRange = 0f..1f,
      modifier = Modifier.width(120.dp),
      colors =
        SliderDefaults.colors(
          thumbColor = MaterialTheme.colorScheme.primary,
          activeTrackColor = MaterialTheme.colorScheme.primary,
          inactiveTrackColor = Color.Gray,
        ),
    )
  }
}

/** Format time in seconds to MM:SS format. */
private fun formatTime(seconds: Float): String {
  val minutes = (seconds / 60).toInt()
  val remainingSeconds = (seconds % 60).toInt()
  return "%02d:%02d".format(Locale.ROOT, minutes, remainingSeconds)
}
