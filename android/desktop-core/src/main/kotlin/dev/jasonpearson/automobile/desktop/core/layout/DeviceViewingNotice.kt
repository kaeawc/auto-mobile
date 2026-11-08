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
import dev.jasonpearson.automobile.desktop.core.daemon.HeldElsewhereHolder
import dev.jasonpearson.automobile.desktop.core.daemon.SessionReleaseReason

/**
 * Shown while the picked device is held elsewhere, so this pane only views it (#10660, #11365):
 * another session, another AutoMobile daemon, or a declared binding ([holder]; null reads as
 * another session). The pane never takes the device on its own, even after the holder releases it;
 * [onTakeControl] is the explicit action that makes one bind attempt.
 */
@Composable
fun DeviceViewingNotice(
  onTakeControl: () -> Unit,
  modifier: Modifier = Modifier,
  holder: HeldElsewhereHolder? = null,
) {
  PaneSessionNotice(
    text = heldElsewhereNoticeText(holder),
    actionLabel = "Take control",
    onAction = onTakeControl,
    modifier = modifier,
  )
}

/** The pane notice for a device held elsewhere, naming who holds it. */
internal fun heldElsewhereNoticeText(holder: HeldElsewhereHolder?): String =
  when (holder) {
    is HeldElsewhereHolder.AnotherDaemon ->
      "Viewing only: held elsewhere by another AutoMobile daemon" +
        (holder.pid?.let { " (PID $it)" } ?: "")
    is HeldElsewhereHolder.Binding ->
      "Viewing only: held elsewhere, reserved for " +
        (holder.declaredBinding?.let { "binding $it" } ?: "a binding")
    HeldElsewhereHolder.AnotherSession,
    null -> "Viewing only: another session controls this device"
  }

/**
 * Shown while the session no longer holds the picked device although the user did not leave it
 * (#10695, #10730). The pane still mirrors it and stays controllable: the first input on it, or
 * [onTakeControl], binds it again. Nothing re-binds it on its own. The text says why it was
 * released ([releasedNoticeText]).
 */
@Composable
fun DeviceIdleReleasedNotice(
  reason: SessionReleaseReason?,
  onTakeControl: () -> Unit,
  modifier: Modifier = Modifier,
) {
  PaneSessionNotice(
    text = releasedNoticeText(reason),
    actionLabel = "Take control",
    onAction = onTakeControl,
    modifier = modifier,
  )
}

/** The pane notice for a released device, specific to [reason]. */
internal fun releasedNoticeText(reason: SessionReleaseReason?): String =
  when (reason) {
    SessionReleaseReason.HIDDEN_WINDOW ->
      "Released while the window was hidden: interact with the device to control it again"
    SessionReleaseReason.IDLE ->
      "Released after 2 minutes of inactivity: interact with the device to control it again"
    SessionReleaseReason.HEARTBEAT_LAPSED ->
      "Released because the daemon lost contact with this session: " +
        "interact with the device to control it again"
    SessionReleaseReason.DAEMON_RESTARTED ->
      "Released because the daemon or device restarted: interact with the device to control it again"
    SessionReleaseReason.DEVICE_SWITCH ->
      "Released when another device was selected, which stopped its recording: " +
        "interact with the device to control it again"
    SessionReleaseReason.DAEMON_RELEASED,
    null ->
      "Released by the daemon (idle for 2 minutes, restarted or expired): " +
        "interact with the device to control it again"
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
