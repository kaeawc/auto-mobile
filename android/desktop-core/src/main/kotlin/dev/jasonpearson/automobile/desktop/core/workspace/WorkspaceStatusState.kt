package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.diagnostics.failingDiagnosticChecks
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

/**
 * The workspace top-bar status (#4857): [daemon] health, the health of every device stream [hub]
 * holds open for an observed pane (see [deviceStreamHealth]), and the count from [failingChecks].
 * No status-only stream is opened; a pane with no open facet stream does not count. Without a hub
 * (e.g. the IDE plugin) only the daemon and checks contribute.
 */
@Composable
fun rememberWorkspaceStatus(
  daemon: ConnectionState,
  workspaceState: WorkspaceUiState,
  hub: DaemonStreamHub? = LocalDaemonStreamHub.current,
  failingChecks: Flow<Int> = remember { failingDiagnosticChecks() },
): WorkspaceStatusResult {
  val columns = (workspaceState as? WorkspaceUiState.Content)?.columns.orEmpty()
  // Re-derive the health flow only when the set of observed epochs changes, not on every UI edit.
  val epochs = columns.map { it.deviceId to it.deviceSessionUuid }
  val devices by
    remember(hub, epochs) { hub?.deviceStreamHealth(columns) ?: flowOf(emptyList()) }
      .collectAsState(emptyList())
  val failing by failingChecks.collectAsState(0)
  return remember(daemon, devices, failing) {
    deriveWorkspaceStatus(daemon = daemon, devices = devices, failingDiagnosticChecks = failing)
  }
}
