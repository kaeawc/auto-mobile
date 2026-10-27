package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.diagnostics.DiagnosticsDashboard
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.RealMcpProcessDetector
import dev.jasonpearson.automobile.desktop.core.workspace.picker.loadingMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Full-window overlay for the workspace health sheet: a dimmed scrim (click-away to dismiss) with a
 * centered panel that hosts [content] and a ✕ close affordance. Mirrors the command palette
 * overlay.
 */
@Composable
internal fun HealthSheetOverlay(
  onDismiss: () -> Unit,
  content: @Composable () -> Unit,
  options: HealthSheetState,
) {
  return with(options) {
    Box(
      modifier =
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)).clickable(
          interactionSource = remember { MutableInteractionSource() },
          indication = null,
        ) {
          onDismiss()
        },
      contentAlignment = Alignment.Center,
    ) {
      Column(
        modifier =
          Modifier.fillMaxWidth(0.6f)
            .fillMaxHeight(0.8f)
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
            // Swallow clicks on the panel so they don't dismiss via the scrim.
            .clickable(
              interactionSource = remember { MutableInteractionSource() },
              indication = null,
            ) {}
            .padding(16.dp)
            .semantics { contentDescription = "Health sheet" },
      ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text("Health", style = MaterialTheme.typography.titleMedium)
          Spacer(Modifier.weight(1f))
          Text(
            "✕",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier =
              Modifier.clickable { onDismiss() }
                .semantics { contentDescription = "Close health sheet" }
                .padding(horizontal = 8.dp, vertical = 4.dp),
          )
        }
        Spacer(Modifier.height(8.dp))
        // Recovery affordance: the only daemon-mutating control in the (otherwise read-only) health
        // sheet, shown only when the status is Red (daemon down) — Start-daemon parity with the
        // device picker (#6035). Green/Yellow keep the sheet purely diagnostic. Gated on a local
        // daemon transport: a non-daemon (HTTP/STDIO) transport reports
        // DaemonBootstrapState.Inactive
        // and its ensureReady() is a no-op, so a Red caused by an HTTP/STDIO disconnect must NOT
        // offer
        // a "Start daemon" button that would silently do nothing (#6080).
        if (status == WorkspaceStatus.Red && bootstrapState !is DaemonBootstrapState.Inactive) {
          DaemonRecoveryHeader(
            bootstrapState = bootstrapState,
            onRecoverDaemon = onRecoverDaemon,
            recovering = recovering,
          )
          Spacer(Modifier.height(8.dp))
        }
        // Constrain the body to the height below the title row so a fillMaxSize() body can't
        // overflow
        // the header out of the panel.
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
      }
    }
  }
}

/**
 * The health sheet's daemon recovery affordance (#6035), shown only for a Red status. A single
 * "Start daemon" Button drives the hoisted [onRecoverDaemon], which the host wires to
 * [dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap.ensureReady] — the same
 * lifecycle seam the device picker's Retry uses, not a second one-off path. While a lifecycle pass
 * is in flight ([DaemonBootstrapState.Working], or the host's synchronous [recovering] claim before
 * the pass reports that phase) the button is disabled and narrates the phase with the picker's
 * [loadingMessage] vocabulary; a [DaemonBootstrapState.Failed] pass surfaces its actionable message
 * below the button.
 */
@Composable
internal fun DaemonRecoveryHeader(
  bootstrapState: DaemonBootstrapState,
  onRecoverDaemon: () -> Unit,
  recovering: Boolean,
) {
  val working = bootstrapState is DaemonBootstrapState.Working
  // Disabled while a pass is in flight — either the host's synchronous [recovering] claim (covering
  // the window between the click and the pass's first reported phase, plus clicks while
  // Dispatchers.IO is saturated) or a [DaemonBootstrapState.Working] phase already flowing back.
  val busy = working || recovering
  // While a pass runs, reuse the picker's phase narration ("Starting AutoMobile …", "Installing the
  // Bun runtime …"); otherwise offer the plain start action.
  val label = if (working) loadingMessage(bootstrapState) else "Start daemon"
  Column(Modifier.fillMaxWidth().semantics { contentDescription = "Daemon recovery" }) {
    Text(
      "AutoMobile daemon isn't available",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurface,
    )
    Spacer(Modifier.height(8.dp))
    Button(onClick = onRecoverDaemon, enabled = !busy) { Text(label) }
    val failure = (bootstrapState as? DaemonBootstrapState.Failed)?.message
    if (failure != null) {
      Spacer(Modifier.height(8.dp))
      Text(
        failure,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
      )
    }
  }
}

/**
 * Full-window overlay hosting the two-device compare surface: a dimmed scrim (click-away to
 * dismiss) with a large centered panel that renders [content] for the chosen [columnA]/[columnB].
 * Mirrors [HealthSheetOverlay]; sized larger because it hosts two device panes side by side.
 */
@Composable
internal fun CompareOverlay(
  columnA: DeviceColumn,
  columnB: DeviceColumn,
  onDismiss: () -> Unit,
  content: @Composable (DeviceColumn, DeviceColumn) -> Unit,
) {
  Box(
    modifier =
      Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)).clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
      ) {
        onDismiss()
      },
    contentAlignment = Alignment.Center,
  ) {
    Column(
      modifier =
        Modifier.fillMaxWidth(0.95f)
          .fillMaxHeight(0.9f)
          .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
          // Swallow clicks on the panel so they don't dismiss via the scrim.
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
          ) {}
          .padding(16.dp)
          .semantics { contentDescription = "Compare devices" },
    ) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
          "Compare — ${columnA.name} vs ${columnB.name}",
          style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.weight(1f))
        Text(
          "✕",
          style = MaterialTheme.typography.titleMedium,
          color = MaterialTheme.colorScheme.onSurface,
          modifier =
            Modifier.clickable { onDismiss() }
              .semantics { contentDescription = "Close compare" }
              .padding(horizontal = 8.dp, vertical = 4.dp),
        )
      }
      Spacer(Modifier.height(8.dp))
      Box(Modifier.weight(1f).fillMaxWidth()) { content(columnA, columnB) }
    }
  }
}

/**
 * Full-window overlay hosting the offline navigation browser: a dimmed scrim (click-away to
 * dismiss) with a centered panel that renders [content]. Mirrors [HealthSheetOverlay].
 */
@Composable
internal fun OfflineBrowseOverlay(onDismiss: () -> Unit, content: @Composable () -> Unit) {
  Box(
    modifier =
      Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)).clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
      ) {
        onDismiss()
      },
    contentAlignment = Alignment.Center,
  ) {
    Column(
      modifier =
        Modifier.fillMaxWidth(0.7f)
          .fillMaxHeight(0.85f)
          .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
          // Swallow clicks on the panel so they don't dismiss via the scrim.
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
          ) {}
          .padding(16.dp)
          .semantics { contentDescription = "Offline navigation browser" },
    ) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Navigation history", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.weight(1f))
        Text(
          "✕",
          style = MaterialTheme.typography.titleMedium,
          color = MaterialTheme.colorScheme.onSurface,
          modifier =
            Modifier.clickable { onDismiss() }
              .semantics { contentDescription = "Close navigation history" }
              .padding(horizontal = 8.dp, vertical = 4.dp),
        )
      }
      Spacer(Modifier.height(8.dp))
      Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
  }
}

/**
 * Default health-sheet body: the live [DiagnosticsDashboard], fed the Unix-socket daemon found by a
 * read-only [RealMcpProcessDetector] scan. Tests inject their own `healthSheetContent`, so this
 * real, system-touching path is exercised only in production / manual runs.
 */
@Composable
internal fun DefaultHealthSheetBody(
  ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
) {
  var daemonProcess by remember { mutableStateOf<McpProcess?>(null) }
  // Read-only detection only. We deliberately do NOT use McpProcessesPanel here: its auto-connect
  // effect can call setActiveDevice and DesktopDaemonLifecycle.ensureVersionMatchedDaemon (which
  // may
  // restart the daemon), and merely opening a diagnostic overlay must never mutate daemon or device
  // state. RealMcpProcessDetector.detectProcesses() just inspects the process/socket table. Re-scan
  // on an interval so the sheet reflects a daemon started/stopped/restarted while it stays open.
  LaunchedEffect(Unit) {
    while (true) {
      val detected = withContext(ioDispatcher) { RealMcpProcessDetector().detectProcesses() }
      // Only a Unix-socket daemon is the desktop's real connection; a detected STDIO process is not
      // "connected", so surface null rather than mislabel it as connected.
      daemonProcess = detected.firstOrNull { it.connectionType == McpConnectionType.UnixSocket }
      delay(HEALTH_SHEET_REFRESH_MS)
    }
  }
  DiagnosticsDashboard(
    connectedMcpProcess = daemonProcess,
    dataSourceMode = DataSourceMode.Real,
    modifier = Modifier.fillMaxSize(),
  )
}

@Composable
internal fun EmptyState(onOpenPicker: () -> Unit, onBrowseHistory: () -> Unit, modifier: Modifier) {
  Column(
    modifier = modifier,
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      "No devices observed",
      style = MaterialTheme.typography.headlineSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))
    Box(
      modifier =
        Modifier.clickable { onOpenPicker() }
          .semantics { contentDescription = "Open Devices" }
          .background(Accent, RoundedCornerShape(6.dp))
          .padding(horizontal = 20.dp, vertical = 10.dp),
    ) {
      Text("Open Devices", color = Color.White)
    }
    Spacer(Modifier.height(12.dp))
    // Offline path (Phase C of #4837): inspect a persisted navigation graph with no device
    // observed.
    Text(
      "Browse navigation history",
      style = MaterialTheme.typography.labelLarge,
      color = Accent,
      modifier =
        Modifier.clickable { onBrowseHistory() }
          .semantics { contentDescription = "Browse navigation history" }
          .padding(horizontal = 12.dp, vertical = 8.dp),
    )
  }
}
