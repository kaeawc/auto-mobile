package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.diagnostics.DiagnosticsDashboard
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.RealMcpProcessDetector
import dev.jasonpearson.automobile.desktop.core.shell.UpdateReadyButton
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import dev.jasonpearson.automobile.desktop.core.workspace.picker.loadingMessage
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

private val StatusGreen = Color(0xFF40C057)
private val StatusYellow = Color(0xFFF0C000)
private val StatusRed = Color(0xFFFA5252)
private val Accent = Color(0xFF4DABF7)

private val LOG = LoggerFactory.getLogger("WorkspaceShell")

// How often the open health sheet re-scans for the daemon process (read-only).
private const val HEALTH_SHEET_REFRESH_MS = 5_000L

// How long a Screenshot capture waits for the observation stream to deliver a frame before giving
// up, so a gone/unresponsive device can't leave the capture coroutine hanging.
private const val SCREENSHOT_CAPTURE_TIMEOUT_MS = 10_000L

// How long the "saved to …" confirmation stays on the pane after a Screenshot capture.
private const val SCREENSHOT_NOTICE_MS = 4_000L

/**
 * Root of the device-tab workspace. Device identity lives in each column header (no top tab bar); a
 * device is observed (a column) or not. This PR lands the shell, the empty state, and the column
 * chrome; real streams, emulator controls, facets, and the picker arrive in later PRs.
 */
@Composable
fun WorkspaceShell(
  state: WorkspaceUiState,
  onAction: (WorkspaceAction) -> Unit,
  onOpenPicker: () -> Unit,
  status: WorkspaceStatus = WorkspaceStatus.Green,
  // A terse reason for a non-green status, shown inline next to the dot ("yellow = one line").
  statusDetail: String? = null,
  // Daemon bootstrap/recovery state, surfaced in the health sheet as a recovery affordance when the
  // status is Red (daemon down). Reuses the picker's DaemonBootstrap seam (#6035) rather than
  // adding
  // a second lifecycle path; the defaults keep the shell stateless/test-friendly and leave every
  // existing call site unchanged.
  bootstrapState: DaemonBootstrapState = DaemonBootstrapState.Inactive,
  // Explicit recovery trigger for the health sheet's "Start daemon" button (Red status only). The
  // host runs DaemonBootstrap.ensureReady() off the main thread; the default is an inert no-op so a
  // shell composed without a daemon lifecycle stays inert.
  onRecoverDaemon: () -> Unit = {},
  // Whether a host-owned recovery pass is already in flight. Set synchronously by the host the
  // instant [onRecoverDaemon] fires and cleared when the launched pass completes, it disables the
  // "Start daemon" button so rapid clicks (or clicks while Dispatchers.IO is saturated, before the
  // pass reports its first Working phase into [bootstrapState]) can't each queue a duplicate
  // ensureReady() — DesktopDaemonLifecycle serializes those rather than coalescing them (#6080).
  recovering: Boolean = false,
  // Update-availability state (#5225): the top bar shows a pill only when an update is available.
  updateStatus: UpdateStatus = UpdateStatus.Idle,
  onUpdateClick: () -> Unit = {},
  onOpenPalette: () -> Unit = {},
  modifier: Modifier = Modifier,
  // Renders the docked facet body for a pane's active tool. Hoisted so the host can supply real
  // per-device dashboards; defaults to a placeholder so un-wired tools stay inert.
  facetContent: @Composable (DeviceColumn, Tool) -> Unit = { _, tool ->
    WorkspaceFacetPlaceholder(tool)
  },
  // Pane content shown while a column is in Inspect mode: the per-device Layout inspector (view
  // hierarchy + device mirror) replaces the stream. Hoisted like [facetContent] so a test can drive
  // it with a fake; the default is the real [LayoutFacet], so the host needs no extra wiring.
  inspectContent: @Composable (DeviceColumn) -> Unit = { LayoutFacet(it) },
  // Body of the pane's stream area while a column is in Input mode. Hoisted like [facetContent] —
  // and defaulting to the inert placeholder for the same reason — so composing the shell in a unit
  // test or preview never opens a relay socket. The host passes the real [DeviceStreamView].
  streamContent: @Composable (DeviceColumn) -> Unit = { WorkspaceStreamPlaceholder() },
  // Per-device observation stream + saver used by the Screenshot control to capture a frame on
  // demand and write it to disk (#4694 AC3). Hoisted (defaulting to the real per-device
  // [ObservationStreamClient] / [RealScreenshotSaver]) so a test can drive the capture with a
  // [dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream] and a fake saver.
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
  screenshotSaver: ScreenshotSaver = RealScreenshotSaver(),
  // Body of the health sheet opened by clicking the status dot. Hoisted like [facetContent] so the
  // host (or a test) can substitute content; defaults to the live [DiagnosticsDashboard].
  healthSheetContent: @Composable () -> Unit = { DefaultHealthSheetBody() },
  // Two-device compare surface opened by the top-bar ⧉ Compare glyph. Hoisted like the other bodies
  // so a test can assert routing without opening real streams; defaults to [TwoDeviceCompareView].
  compareContent: @Composable (DeviceColumn, DeviceColumn) -> Unit = { a, b ->
    TwoDeviceCompareView(columnA = a, columnB = b)
  },
  // Body of the offline-browse overlay opened from the empty state's "Browse navigation history"
  // affordance. Lets the user inspect a persisted navigation graph with no device observed (Phase C
  // of #4837). Hoisted like the other bodies so a test can drive it with a fake data source;
  // defaults to the real [OfflineNavigationBrowser].
  offlineBrowseContent: @Composable () -> Unit = { OfflineNavigationBrowser() },
) {
  var showHealthSheet by remember { mutableStateOf(false) }
  var showCompare by remember { mutableStateOf(false) }
  var showOfflineBrowse by remember { mutableStateOf(false) }
  val comparePair = (state as? WorkspaceUiState.Content)?.let(::compareColumns)
  // A pane closing can drop the observed count below two; retire any open compare so it can't
  // linger with a stale pair.
  if (comparePair == null && showCompare) showCompare = false
  // Offline browse is only meaningful with no device observed; if one is observed mid-browse
  // (Empty -> Content) retire the overlay so it can't linger (with its offline badge) over a live
  // workspace.
  if (state !is WorkspaceUiState.Empty && showOfflineBrowse) showOfflineBrowse = false
  // A full-window overlay is open when any of the three scrimmed panels is showing. While one is,
  // the workspace behind the scrim is made inert to keyboard/screen-reader focus (#4846) so a Tab
  // or an assistive-tech swipe can't reach the visually-dimmed controls behind the overlay. Mirror
  // the exact render conditions below so isolation tracks the overlays one-for-one.
  val overlayActive = showHealthSheet || (showCompare && comparePair != null) || showOfflineBrowse
  Box(modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().isolatedBehindOverlay(overlayActive)) {
      TopBar(
        status = status,
        statusDetail = statusDetail,
        updateStatus = updateStatus,
        onUpdateClick = onUpdateClick,
        onOpenPicker = onOpenPicker,
        onOpenPalette = onOpenPalette,
        onStatusClick = { showHealthSheet = true },
        canCompare = comparePair != null,
        onCompare = { showCompare = true },
      )
      when (state) {
        is WorkspaceUiState.Empty ->
          EmptyState(
            onOpenPicker = onOpenPicker,
            onBrowseHistory = { showOfflineBrowse = true },
            modifier = Modifier.weight(1f).fillMaxWidth(),
          )
        is WorkspaceUiState.Content ->
          Row(Modifier.weight(1f).fillMaxWidth()) {
            val canDiff = state.columns.size > 1
            state.columns.forEach { column ->
              // Key by deviceId so a surviving pane keeps its own remembered state + facet
              // connection when another pane closes (unkeyed = positional identity churns
              // survivors).
              key(column.deviceId) {
                DeviceColumnView(
                  column = column,
                  focused = column.deviceId == state.focusedDeviceId,
                  onAction = onAction,
                  facetContent = facetContent,
                  inspectContent = inspectContent,
                  streamContent = streamContent,
                  observationStreamFactory = observationStreamFactory,
                  screenshotSaver = screenshotSaver,
                  canDiff = canDiff,
                  modifier = Modifier.weight(1f).fillMaxHeight(),
                )
              }
            }
          }
      }
    }
    if (showHealthSheet) {
      HealthSheetOverlay(
        status = status,
        bootstrapState = bootstrapState,
        onRecoverDaemon = onRecoverDaemon,
        recovering = recovering,
        onDismiss = { showHealthSheet = false },
        content = healthSheetContent,
      )
    }
    if (showCompare && comparePair != null) {
      CompareOverlay(
        columnA = comparePair.first,
        columnB = comparePair.second,
        onDismiss = { showCompare = false },
        content = compareContent,
      )
    }
    if (showOfflineBrowse) {
      OfflineBrowseOverlay(
        onDismiss = { showOfflineBrowse = false },
        content = offlineBrowseContent,
      )
    }
  }
}

/**
 * Makes the content this modifies inert to keyboard and screen-reader focus while [active] is true,
 * for the workspace behind a full-window overlay (issue #4846). Removing the subtree from the focus
 * tree ([focusProperties] `canFocus = false` on a [focusGroup]) keeps a Tab from landing on the
 * dimmed controls behind the scrim, and [clearAndSetSemantics] drops the whole subtree from the
 * accessibility tree so assistive tech can't traverse behind the overlay either. A no-op when
 * [active] is false, so the un-overlaid workspace keeps its normal focus order and semantics.
 *
 * Public (not private) so the app root can apply the same isolation to the whole [WorkspaceShell]
 * when it hosts a sibling overlay of its own (the ⌘K command palette), keeping every workspace
 * overlay modal through one mechanism.
 */
fun Modifier.isolatedBehindOverlay(active: Boolean): Modifier =
  if (active) {
    focusProperties { canFocus = false }.focusGroup().clearAndSetSemantics {}
  } else {
    this
  }

/**
 * Pick the two device columns to compare: the focused column plus the first other observed column.
 * Returns null when there is no second device, so the ⧉ Compare entry stays hidden. If more than
 * two devices are observed, only the focused device and one other are compared (N-way compare is
 * deferred).
 *
 * A cross-platform (Android↔iOS) pair is allowed: [TwoDeviceCompareView] keys such a diff by the
 * cross-platform [structuralRole][dev.jasonpearson.automobile.desktop.core.layout.structuralRole]
 * of each node (issue #4872) rather than by the platform-specific `className`, so the two trees
 * pair by role + tree position and produce a meaningful diff instead of two disjoint only-in trees.
 * A same-platform pair keeps the raw-class identity.
 */
internal fun compareColumns(content: WorkspaceUiState.Content): Pair<DeviceColumn, DeviceColumn>? {
  val focused =
    content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
      ?: content.columns.firstOrNull()
      ?: return null
  val other = content.columns.firstOrNull { it.deviceId != focused.deviceId } ?: return null
  return focused to other
}

@Composable
private fun TopBar(
  status: WorkspaceStatus,
  statusDetail: String?,
  updateStatus: UpdateStatus,
  onUpdateClick: () -> Unit,
  onOpenPicker: () -> Unit,
  onOpenPalette: () -> Unit,
  onStatusClick: () -> Unit,
  canCompare: Boolean,
  onCompare: () -> Unit,
) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .height(40.dp)
        .background(MaterialTheme.colorScheme.surfaceVariant)
        .padding(horizontal = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      modifier =
        Modifier.clickable { onOpenPicker() }
          .semantics { contentDescription = "Devices" }
          .padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("Devices", style = MaterialTheme.typography.labelLarge)
      Text("  +", color = Accent, fontWeight = FontWeight.Bold)
    }
    Spacer(Modifier.weight(1f))
    // ⧉ Compare opens the two-device hierarchy-diff surface; only meaningful with >1 device, so it
    // is shown only when at least two devices are observed.
    if (canCompare) {
      Text(
        "⧉",
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier =
          Modifier.clickable { onCompare() }
            .semantics { contentDescription = "Compare two devices" }
            .padding(horizontal = 8.dp, vertical = 4.dp),
      )
      Spacer(Modifier.width(8.dp))
    }
    // Quick-jump command palette (⌘K).
    Text(
      "⌘K",
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier =
        Modifier.clickable { onOpenPalette() }
          .semantics { contentDescription = "Open command palette" }
          .padding(horizontal = 8.dp, vertical = 4.dp),
    )
    Spacer(Modifier.width(8.dp))
    // "Yellow = one inline line": a non-green status shows a terse reason next to the dot; green
    // stays a bare dot. The dot (and the line) open the health sheet on click.
    if (status != WorkspaceStatus.Green && statusDetail != null) {
      Text(
        statusDetail,
        style = MaterialTheme.typography.labelMedium,
        // Legibility over the top bar's surfaceVariant: the status color lives on the dot; the
        // detail text uses onSurfaceVariant so it stays readable in both light and dark themes
        // (status yellow #F0C000 on the light surfaceVariant is ~1.5:1, unreadable).
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier =
          // Content-sized and capped at 260dp with ellipsis. The leading weighted Spacer pushes
          // this trailing cluster right, so the dot (the last child) stays hard-right; a weight
          // here would leave an unfilled allocation that shifts the dot left for short details.
          Modifier.widthIn(max = 260.dp)
            .clickable { onStatusClick() }
            .semantics { contentDescription = "Status detail: $statusDetail" }
            .padding(horizontal = 8.dp, vertical = 4.dp),
      )
    }
    // Update-ready affordance — sits just before the status dot; visible only when an update is
    // available (#5225).
    UpdateReadyButton(status = updateStatus, onClick = onUpdateClick)
    if (updateStatus is UpdateStatus.UpdateAvailable) {
      Spacer(Modifier.width(8.dp))
    }

    // Visible dot stays 12dp; the clickable target is enlarged to 32dp. For a green status (no
    // inline line) the dot is the only entry point to the health sheet.
    Box(
      modifier =
        Modifier.size(32.dp)
          .clickable { onStatusClick() }
          .semantics { contentDescription = "Status: ${status.name}" },
      contentAlignment = Alignment.Center,
    ) {
      Box(Modifier.size(12.dp).background(status.color(), CircleShape))
    }
  }
}

/**
 * Full-window overlay for the workspace health sheet: a dimmed scrim (click-away to dismiss) with a
 * centered panel that hosts [content] and a ✕ close affordance. Mirrors the command palette
 * overlay.
 */
@Composable
private fun HealthSheetOverlay(
  status: WorkspaceStatus,
  bootstrapState: DaemonBootstrapState,
  onRecoverDaemon: () -> Unit,
  recovering: Boolean,
  onDismiss: () -> Unit,
  content: @Composable () -> Unit,
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
        Modifier.fillMaxWidth(0.6f)
          .fillMaxHeight(0.8f)
          .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
          // Swallow clicks on the panel so they don't dismiss via the scrim.
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
          ) {}
          .padding(16.dp)
          .semantics { contentDescription = "Health sheet" }
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
      // device
      // picker (#6035). Green/Yellow keep the sheet purely diagnostic.
      if (status == WorkspaceStatus.Red) {
        DaemonRecoveryHeader(
          bootstrapState = bootstrapState,
          onRecoverDaemon = onRecoverDaemon,
          recovering = recovering,
        )
        Spacer(Modifier.height(8.dp))
      }
      // Constrain the body to the height below the title row so a fillMaxSize() body can't overflow
      // the header out of the panel.
      Box(Modifier.weight(1f).fillMaxWidth()) { content() }
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
private fun DaemonRecoveryHeader(
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
private fun CompareOverlay(
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
          .semantics { contentDescription = "Compare devices" }
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
 * Default health-sheet body: the live [DiagnosticsDashboard], fed the Unix-socket daemon found by a
 * read-only [RealMcpProcessDetector] scan. Tests inject their own `healthSheetContent`, so this
 * real, system-touching path is exercised only in production / manual runs.
 */
@Composable
private fun DefaultHealthSheetBody() {
  var daemonProcess by remember { mutableStateOf<McpProcess?>(null) }
  // Read-only detection only. We deliberately do NOT use McpProcessesPanel here: its auto-connect
  // effect can call setActiveDevice and DesktopDaemonLifecycle.ensureVersionMatchedDaemon (which
  // may
  // restart the daemon), and merely opening a diagnostic overlay must never mutate daemon or device
  // state. RealMcpProcessDetector.detectProcesses() just inspects the process/socket table. Re-scan
  // on an interval so the sheet reflects a daemon started/stopped/restarted while it stays open.
  LaunchedEffect(Unit) {
    while (true) {
      val detected = withContext(Dispatchers.IO) { RealMcpProcessDetector().detectProcesses() }
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
private fun EmptyState(onOpenPicker: () -> Unit, onBrowseHistory: () -> Unit, modifier: Modifier) {
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
          .padding(horizontal = 20.dp, vertical = 10.dp)
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

/**
 * Full-window overlay hosting the offline navigation browser: a dimmed scrim (click-away to
 * dismiss) with a centered panel that renders [content]. Mirrors [HealthSheetOverlay].
 */
@Composable
private fun OfflineBrowseOverlay(onDismiss: () -> Unit, content: @Composable () -> Unit) {
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
          .semantics { contentDescription = "Offline navigation browser" }
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
 * Fraction of a pane's content height given to the docked facet when a tool is active. Shrinking
 * the pane (⤡) collapses the stream to grow the facet, so the shrunk fraction is the larger one.
 * The complement `1 - fraction` is the stream's share; both stay strictly within (0, 1) so they are
 * valid Compose weights. `internal` (not `private`) so the same-module pure test can pin the ratio.
 */
internal fun facetHeightFraction(shrunk: Boolean): Float = if (shrunk) 0.8f else 0.35f

@Composable
private fun DeviceColumnView(
  column: DeviceColumn,
  focused: Boolean,
  onAction: (WorkspaceAction) -> Unit,
  facetContent: @Composable (DeviceColumn, Tool) -> Unit,
  inspectContent: @Composable (DeviceColumn) -> Unit,
  streamContent: @Composable (DeviceColumn) -> Unit,
  observationStreamFactory: (String) -> ObservationStream,
  screenshotSaver: ScreenshotSaver,
  canDiff: Boolean,
  modifier: Modifier,
) {
  Column(
    modifier =
      modifier
        // Click anywhere in an UNFOCUSED pane to make it the focused (and thus interactive) device.
        // Control is focus-gated — only the focused pane arms, streams High-fps, and takes keyboard
        // focus — so without a way to move focus by clicking, every non-focused video pane would be
        // a dead mirror (the command palette was the only focus setter). This is a two-step
        // interaction by design: an unfocused pane renders the inert video mirror, so this focusing
        // click only SWITCHES focus (it cannot actuate a device tap — the DeviceScreenView tap
        // surface mounts once the pane is focused); the next click drives the device. Observed on
        // the INITIAL pass and never consumed, so it doesn't swallow the pane's always-mounted
        // controls (the command bar's Screenshot/nav buttons still fire on that same click). Gated
        // on !focused so clicking the already-focused pane emits nothing.
        .pointerInput(column.deviceId, focused) {
          if (!focused) {
            awaitEachGesture {
              awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
              onAction(WorkspaceAction.FocusDevice(column.deviceId))
            }
          }
        }
        .border(
          width = if (focused) 2.dp else 1.dp,
          color = if (focused) Accent else MaterialTheme.colorScheme.outlineVariant,
        )
  ) {
    DeviceColumnHeader(column, onAction)
    val tool = column.activeTool
    if (tool == null) {
      PaneMainContent(
        column,
        onAction,
        inspectContent,
        streamContent,
        observationStreamFactory,
        screenshotSaver,
        Modifier.weight(1f),
      )
    } else {
      // With a tool active the pane splits main content + docked facet; ⤡ shrink flips the split so
      // the main content collapses to grow the facet.
      val facetFraction = facetHeightFraction(column.shrunk)
      PaneMainContent(
        column,
        onAction,
        inspectContent,
        streamContent,
        observationStreamFactory,
        screenshotSaver,
        Modifier.weight(1f - facetFraction),
      )
      DockedFacet(column, tool, onAction, facetContent, canDiff, Modifier.weight(facetFraction))
    }
  }
}

/**
 * The pane's primary content above any docked facet. In [InteractionMode.Input] this is the device
 * [StreamArea]; in [InteractionMode.Inspect] the stream is replaced by [inspectContent] (the
 * per-device Layout inspector), so the wireframe's 🔍 toggle gains behavior without adding a Tool.
 */
@Composable
private fun PaneMainContent(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  inspectContent: @Composable (DeviceColumn) -> Unit,
  streamContent: @Composable (DeviceColumn) -> Unit,
  observationStreamFactory: (String) -> ObservationStream,
  screenshotSaver: ScreenshotSaver,
  modifier: Modifier,
) {
  if (column.mode == InteractionMode.Inspect) {
    Box(modifier.fillMaxWidth()) { inspectContent(column) }
  } else {
    StreamArea(column, onAction, streamContent, observationStreamFactory, screenshotSaver, modifier)
  }
}

/**
 * The pane's device stream area: the hoisted [streamContent] body (the host's live
 * [DeviceStreamView], or the placeholder default) with the emulator controls floating on it. The
 * Screenshot control captures the current frame off the observation stream and writes it to disk
 * via [screenshotSaver] — the pane already shows the device live, so Screenshot persists a still
 * rather than previewing one (#4694 AC3) — then flashes a transient "saved to …" confirmation.
 */
@Composable
private fun StreamArea(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  streamContent: @Composable (DeviceColumn) -> Unit,
  observationStreamFactory: (String) -> ObservationStream,
  screenshotSaver: ScreenshotSaver,
  modifier: Modifier,
) {
  // Result of the latest capture + a monotonically increasing request token. Keyed on deviceId so a
  // pane reused for a different device (panes are keyed by id, so this is defensive) starts clean.
  var savedNotice by remember(column.deviceId) { mutableStateOf<String?>(null) }
  var captureRequest by remember(column.deviceId) { mutableStateOf(0) }

  // Each Screenshot tap bumps captureRequest, re-running this effect: open a fresh per-device
  // stream,
  // ask for an observation, take the first screenshot frame the subscription delivers, write its
  // PNG
  // bytes to disk, and report where. Bounded by a timeout so a gone device can't hang the
  // coroutine,
  // and the stream is always disposed — including on cancellation when the pane closes or a newer
  // tap
  // supersedes it.
  LaunchedEffect(column.deviceId, captureRequest) {
    if (captureRequest == 0) return@LaunchedEffect
    val stream = observationStreamFactory(column.deviceId)
    try {
      val base64 =
        withContext(Dispatchers.IO) {
          // Connect/subscribe are blocking socket writes — keep them off the UI thread.
          stream.connect(column.deviceId)
          stream.requestObservation(column.deviceId)
          withTimeoutOrNull(SCREENSHOT_CAPTURE_TIMEOUT_MS) {
            stream.screenshotUpdates.first { !it.screenshotBase64.isNullOrEmpty() }.screenshotBase64
          }
        }
      savedNotice =
        if (base64 != null) {
          val path =
            withContext(Dispatchers.IO) {
              screenshotSaver.save(column.name, Base64.getDecoder().decode(base64))
            }
          "Saved $path"
        } else {
          LOG.warn("Screenshot capture timed out for ${column.deviceId}")
          "Screenshot timed out"
        }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: Exception) {
      LOG.warn("Screenshot save failed for ${column.deviceId}: ${error.message}", error)
      savedNotice = "Screenshot failed"
    } finally {
      // NonCancellable so the socket is still closed when this coroutine is cancelled (pane close /
      // superseded capture); IO so the unsubscribe write + close don't run on the UI thread.
      withContext(NonCancellable + Dispatchers.IO) { stream.dispose() }
    }
  }

  // Auto-dismiss the confirmation after a short while.
  LaunchedEffect(savedNotice) {
    if (savedNotice != null) {
      delay(SCREENSHOT_NOTICE_MS)
      savedNotice = null
    }
  }

  Box(
    modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant),
    contentAlignment = Alignment.Center,
  ) {
    streamContent(column)
    DeviceCommandBar(
      column = column,
      onAction = onAction,
      onCaptureScreenshot = { captureRequest++ },
      modifier = Modifier.align(Alignment.CenterEnd).padding(6.dp),
    )
    val notice = savedNotice
    if (notice != null) {
      Text(
        notice,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier =
          Modifier.align(Alignment.BottomCenter)
            .padding(6.dp)
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 3.dp)
            .semantics { contentDescription = "Screenshot status ${column.name}" },
      )
    }
  }
}

/**
 * The docked facet (tool window) for a pane's active [tool]: a header with the tool icon + label
 * and a ✕ that deselects the tool, over a body supplied by [facetContent]. The body is hoisted so
 * the host can drop in real per-device dashboards; the default is [WorkspaceFacetPlaceholder].
 */
@Composable
private fun DockedFacet(
  column: DeviceColumn,
  tool: Tool,
  onAction: (WorkspaceAction) -> Unit,
  facetContent: @Composable (DeviceColumn, Tool) -> Unit,
  canDiff: Boolean,
  modifier: Modifier,
) {
  Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
    Row(
      modifier = Modifier.fillMaxWidth().height(30.dp).padding(horizontal = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(tool.icon)
      Spacer(Modifier.width(6.dp))
      // Weighted + ellipsized so a long label on a narrow pane yields space to the trailing
      // controls
      // instead of pushing them off-screen.
      Text(
        tool.label,
        style = MaterialTheme.typography.labelLarge,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      Spacer(Modifier.width(6.dp))
      // ⧉ Diff opens the same tool on the other observed devices; only meaningful with >1 device.
      if (canDiff) {
        Glyph(
          text = "⧉",
          description = "Open ${tool.label} on all devices",
          active = false,
          onClick = { onAction(WorkspaceAction.DiffTool(tool)) },
        )
        Spacer(Modifier.width(6.dp))
      }
      Glyph(
        text = "✕",
        description = "Close ${tool.label} facet on ${column.name}",
        active = false,
        onClick = { onAction(WorkspaceAction.SelectTool(column.deviceId, null)) },
      )
    }
    Box(Modifier.weight(1f).fillMaxWidth()) { facetContent(column, tool) }
  }
}

/**
 * Default docked-facet body: a centered "coming soon" note for a tool with no wired dashboard.
 * Public so a host that wires real content for only some tools can reuse it as the fallback for the
 * rest (see [WorkspaceShell]'s `facetContent`).
 */
@Composable
fun WorkspaceFacetPlaceholder(tool: Tool) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text("${tool.label} — coming soon", color = MaterialTheme.colorScheme.outline)
  }
}

/**
 * Default stream-area body: the inert pre-live placeholder. Hosts swap in [DeviceStreamView] via
 * [WorkspaceShell]'s `streamContent` slot; tests and previews keep this so composing the shell
 * never opens a relay socket.
 */
@Composable
fun WorkspaceStreamPlaceholder() {
  Text("stream", color = MaterialTheme.colorScheme.outline)
}

/**
 * Emulator controls floating on a device stream: rotate · screenshot · snapshot, plus a contextual
 * 🔓 Unlock shown only when the device is locked (fed by the host's lock-state poll, #4694 AC0).
 * Rotate/Snapshot/Unlock are one-shot [WorkspaceAction.RunControl] device calls; Screenshot instead
 * triggers [onCaptureScreenshot], because it captures the current frame to disk (surfaced in the
 * pane as a confirmation) rather than being a fire-and-forget device mutation.
 */
@Composable
private fun DeviceCommandBar(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  onCaptureScreenshot: () -> Unit,
  modifier: Modifier,
) {
  Column(
    modifier =
      modifier
        .clip(RoundedCornerShape(18.dp))
        .background(Color.Black.copy(alpha = 0.32f))
        .padding(4.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    // Device navigation: Back / Home / Recent.
    listOf(DeviceButton.Back, DeviceButton.Home, DeviceButton.Recent)
      .filter { it.isSupportedOn(column.platform, column.isVirtual) }
      .forEach { button ->
        CrayonButton(button.crayon(), "${button.label} ${column.name}") {
          onAction(WorkspaceAction.PressDeviceButton(column.deviceId, button))
        }
      }
    // Emulator controls: Unlock is gated on lock state; Screenshot captures to disk; Locale opens a
    // picker; the rest are one-shot device calls. More is dropped — every device button is surfaced
    // in this bar directly.
    EmulatorControl.entries
      .filter { it != EmulatorControl.More }
      .filter { it != EmulatorControl.Unlock || column.locked }
      .filter { it.isSupportedOn(column.platform, column.isVirtual) }
      .forEach { control ->
        when (control) {
          EmulatorControl.Screenshot ->
            CrayonButton(
              control.crayon(),
              "${control.label} ${column.name}",
              onClick = onCaptureScreenshot,
            )
          EmulatorControl.Locale -> LocaleControl(column, onAction)
          else ->
            CrayonButton(control.crayon(), "${control.label} ${column.name}") {
              onAction(WorkspaceAction.RunControl(column.deviceId, control))
            }
        }
      }
    // Power, at the foot of the bar.
    if (DeviceButton.Power.isSupportedOn(column.platform, column.isVirtual)) {
      CrayonButton(DeviceButton.Power.crayon(), "${DeviceButton.Power.label} ${column.name}") {
        onAction(WorkspaceAction.PressDeviceButton(column.deviceId, DeviceButton.Power))
      }
    }
  }
}

/** An outline crayon icon button for the device command bar — white glyph, no fill. */
@Composable
private fun CrayonButton(
  glyph: CrayonGlyph,
  description: String,
  active: Boolean = false,
  onClick: () -> Unit,
) {
  Box(
    modifier =
      Modifier.size(30.dp)
        .clip(CircleShape)
        .then(if (active) Modifier.background(Color.White.copy(alpha = 0.16f)) else Modifier)
        .clickable(onClick = onClick)
        .semantics { contentDescription = description }
        .padding(6.dp),
    contentAlignment = Alignment.Center,
  ) {
    CrayonIcon(glyph, tint = Color.White, modifier = Modifier.fillMaxSize())
  }
}

/**
 * Locale control: a crayon globe that opens a dropdown of [COMMON_LOCALES]; a pick sets the locale.
 */
@Composable
private fun LocaleControl(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  var open by remember { mutableStateOf(false) }
  Box {
    CrayonButton(
      EmulatorControl.Locale.crayon(),
      "${EmulatorControl.Locale.label} ${column.name}",
      open,
    ) {
      open = true
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      COMMON_LOCALES.forEach { locale ->
        DropdownMenuItem(
          text = { Text("${locale.label} (${locale.tag})") },
          modifier =
            Modifier.semantics { contentDescription = "Locale ${locale.label} ${column.name}" },
          onClick = {
            open = false
            onAction(WorkspaceAction.SetLocale(column.deviceId, locale.tag))
          },
        )
      }
    }
  }
}

@Composable
private fun DeviceColumnHeader(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .height(34.dp)
        .background(MaterialTheme.colorScheme.surface)
        .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    val isIos = column.platform == Platform.Ios
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = PlatformIcons.contentDescription(isIos),
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    Spacer(Modifier.width(6.dp))
    Text(column.name, style = MaterialTheme.typography.labelLarge)
    Spacer(Modifier.width(10.dp))
    ModeToggle(column, onAction)
    Spacer(Modifier.weight(1f))
    Tool.entries.forEach { tool ->
      val active = column.activeTool == tool
      Glyph(
        text = tool.icon,
        // Device name disambiguates identical tool labels across panes for a11y / automation.
        description = "${tool.label} ${column.name}",
        active = active,
        // Re-tapping the active tool closes its facet.
        onClick = {
          onAction(WorkspaceAction.SelectTool(column.deviceId, if (active) null else tool))
        },
      )
    }
    Spacer(Modifier.width(4.dp))
    Glyph(
      text = "⤡",
      description = "Shrink ${column.name}",
      active = column.shrunk,
      onClick = { onAction(WorkspaceAction.ToggleShrink(column.deviceId)) },
    )
    Glyph(
      text = "✕",
      description = "Close ${column.name}",
      active = false,
      onClick = { onAction(WorkspaceAction.CloseDevice(column.deviceId)) },
    )
  }
}

@Composable
private fun ModeToggle(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  Row {
    ToggleCell(
      text = "✋",
      description = "Input mode",
      active = column.mode == InteractionMode.Input,
      onClick = { onAction(WorkspaceAction.SetMode(column.deviceId, InteractionMode.Input)) },
    )
    ToggleCell(
      text = "🔍",
      description = "Inspect mode",
      active = column.mode == InteractionMode.Inspect,
      onClick = { onAction(WorkspaceAction.SetMode(column.deviceId, InteractionMode.Inspect)) },
    )
  }
}

@Composable
private fun ToggleCell(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.clickable(onClick = onClick)
        .semantics { contentDescription = description }
        .background(
          if (active) Accent else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .padding(horizontal = 6.dp, vertical = 3.dp)
  ) {
    Text(text)
  }
}

@Composable
private fun Glyph(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.clickable(onClick = onClick)
        .semantics { contentDescription = description }
        .background(
          if (active) Accent.copy(alpha = 0.35f) else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .padding(horizontal = 4.dp, vertical = 2.dp)
  ) {
    Text(text)
  }
}

private fun WorkspaceStatus.color(): Color =
  when (this) {
    WorkspaceStatus.Green -> StatusGreen
    WorkspaceStatus.Yellow -> StatusYellow
    WorkspaceStatus.Red -> StatusRed
  }
