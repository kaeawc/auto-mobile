package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import kotlinx.coroutines.delay

/**
 * How long a block reason must hold before [DeviceControlBlockedNotice] shows it. During normal
 * streaming the transient reasons (UnpairedHierarchy while a fresh hierarchy is in flight,
 * StaleFrame across a capture hiccup) come and go within a frame or two; only a reason that
 * persists is worth telling the user about, so the notice never flickers in steady state.
 */
internal const val DEVICE_CONTROL_BLOCK_NOTICE_HOLD_MS: Long = 1_500L

/**
 * The user-facing explanation for [reason], or null for reasons that are a deliberate host
 * configuration rather than a condition the user can observe or wait out (issue #3490).
 *
 * NotEnabled is null because the host opted out of device control entirely — the IDE plugin is
 * permanently inspector-only, and a notice there would be a constant fixture, not information.
 * NotRealDeviceMode is null for the same shape of reason: mock data is a mode the user chose.
 */
internal fun deviceControlBlockReasonText(reason: DeviceControlBlockReason): String? =
  when (reason) {
    DeviceControlBlockReason.NotEnabled -> null
    DeviceControlBlockReason.NotRealDeviceMode -> null
    DeviceControlBlockReason.NoDeviceSelected -> "Device control needs a device selected"
    DeviceControlBlockReason.TransportCannotCarryInput ->
      "Device control unavailable: this connection cannot carry input"
    DeviceControlBlockReason.ObservationStreamDisconnected ->
      "Device control paused: observation stream disconnected"
    DeviceControlBlockReason.NoFrame -> "Device control waiting for the first frame"
    DeviceControlBlockReason.DeviceMismatch ->
      "Device control paused: displayed frame is from a different device"
    DeviceControlBlockReason.UnpairedHierarchy ->
      "Device control paused: waiting for screenshot and layout to sync"
    DeviceControlBlockReason.CaptureIdentityUnavailable ->
      "Device control unavailable: daemon does not report capture identity"
    DeviceControlBlockReason.StaleFrame -> "Device control paused: frame is stale"
    DeviceControlBlockReason.GeometryMismatch ->
      "Device control paused: screenshot and layout geometry disagree"
    DeviceControlBlockReason.LiveFrameGeometryUnverifiable ->
      "Device control paused: live mirror resolution does not match the device"
  }

/**
 * Small non-intrusive badge explaining why client device control is currently unavailable
 * (issue #3490). [DeviceControlPolicy][dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy]
 * names exactly why control is blocked; without this the view silently falls back to inspector mode
 * and a click simply stops actuating the device with no explanation.
 *
 * Renders nothing until [reason] has held unchanged for [holdMs] (see
 * [DEVICE_CONTROL_BLOCK_NOTICE_HOLD_MS]), and nothing at all for reasons
 * [deviceControlBlockReasonText] maps to null, so hosts that never enable control (the IDE plugin)
 * are unaffected.
 */
@Composable
fun DeviceControlBlockedNotice(
  reason: DeviceControlBlockReason?,
  modifier: Modifier = Modifier,
  holdMs: Long = DEVICE_CONTROL_BLOCK_NOTICE_HOLD_MS,
) {
  val text = reason?.let { deviceControlBlockReasonText(it) }
  var held by remember { mutableStateOf(false) }
  LaunchedEffect(text, holdMs) {
    held = false
    if (text != null) {
      delay(holdMs)
      held = true
    }
  }
  if (text == null || !held) return

  Row(
    modifier =
      modifier
        .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(4.dp))
        .padding(horizontal = 8.dp, vertical = 4.dp)
  ) {
    Text(
      text = text,
      color = Color.White.copy(alpha = 0.85f),
      fontSize = 10.sp,
      maxLines = 1,
    )
  }
}
