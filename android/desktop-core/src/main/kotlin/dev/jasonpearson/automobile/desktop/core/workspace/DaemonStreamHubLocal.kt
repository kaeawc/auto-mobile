package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushSocketClient

/**
 * The process-wide [DaemonStreamHub] facets draw device streams from. Null (the default, e.g. the
 * IDE plugin) keeps each facet's own per-pane connection.
 */
val LocalDaemonStreamHub = staticCompositionLocalOf<DaemonStreamHub?> { null }

/**
 * Remembers one [SharedDaemonStreamHub] for the composition's lifetime and closes it on dispose.
 * [sessionUuidProvider] is read at connect time, so registering the desktop session later needs no
 * new hub.
 */
@Composable
fun rememberDaemonStreamHub(sessionUuidProvider: () -> String?): DaemonStreamHub {
  val latestSessionUuidProvider by rememberUpdatedState(sessionUuidProvider)
  val hub = remember {
    SharedDaemonStreamHub(
      {
        TelemetryPushSocketClient(sessionUuidProvider = { latestSessionUuidProvider() })
      },
    )
  }
  DisposableEffect(hub) { onDispose { hub.close() } }
  return hub
}
