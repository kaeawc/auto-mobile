package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream

/**
 * Reports [deviceId]'s foreground app from the hierarchy frames of an observation [stream] the
 * caller already holds, so the window title can follow it without opening another observation.
 * Blank or missing packages and other devices' frames are not reported.
 */
@Composable
internal fun ForegroundAppReporter(
  stream: ObservationStream?,
  deviceId: String,
  onForegroundApp: (deviceId: String, packageName: String) -> Unit,
) {
  val report by rememberUpdatedState(onForegroundApp)
  LaunchedEffect(stream, deviceId) {
    val active = stream ?: return@LaunchedEffect
    active.hierarchyUpdates.collect { update ->
      if (update.deviceId != deviceId) return@collect
      update.packageName?.takeIf { it.isNotBlank() }?.let { report(deviceId, it) }
    }
  }
}
