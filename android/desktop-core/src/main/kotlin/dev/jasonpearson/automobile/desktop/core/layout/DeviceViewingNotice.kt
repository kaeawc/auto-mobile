package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Shown while the picked device is held by another session, so this pane only views it (#10660).
 * The pane never takes the device on its own, even after the holder releases it; [onTakeControl] is
 * the explicit action that makes one bind attempt.
 */
@Composable
fun DeviceViewingNotice(onTakeControl: () -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier =
      modifier
        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(6.dp))
        .padding(start = 12.dp, end = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      text = "Viewing only: another session controls this device",
      color = Color.White.copy(alpha = 0.9f),
      fontSize = 11.sp,
    )
    TextButton(onClick = onTakeControl) { Text("Take control", fontSize = 11.sp) }
  }
}
