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
  PaneSessionNotice(
    text = "Viewing only: another session controls this device",
    actionLabel = "Take control",
    onAction = onTakeControl,
    modifier = modifier,
  )
}

/**
 * Shown while the daemon has released the picked device from this desktop for inactivity (2 min
 * with no tool call or input). The pane still mirrors it and stays controllable: the first input on
 * it, or [onTakeControl], binds it again. Nothing re-binds it on its own.
 */
@Composable
fun DeviceIdleReleasedNotice(onTakeControl: () -> Unit, modifier: Modifier = Modifier) {
  PaneSessionNotice(
    text = "Released after inactivity: interact with the device to control it again",
    actionLabel = "Take control",
    onAction = onTakeControl,
    modifier = modifier,
  )
}

/**
 * Shown when binding the picked device failed for a reason other than another session holding it
 * (#10682), after the session loop's bounded retries. [onRetry] makes one more bind attempt.
 */
@Composable
fun DeviceBindErrorNotice(message: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
  PaneSessionNotice(
    text = "Could not connect to this device: $message",
    actionLabel = "Retry",
    onAction = onRetry,
    modifier = modifier,
  )
}

@Composable
private fun PaneSessionNotice(
  text: String,
  actionLabel: String,
  onAction: () -> Unit,
  modifier: Modifier,
) {
  Row(
    modifier =
      modifier
        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(6.dp))
        .padding(start = 12.dp, end = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(text = text, color = Color.White.copy(alpha = 0.9f), fontSize = 11.sp)
    TextButton(onClick = onAction) { Text(actionLabel, fontSize = 11.sp) }
  }
}
