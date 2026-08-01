package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.diagnostics.DiagnosticsDashboard
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.RealMcpProcessDetector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val StatusGreen = Color(0xFF40C057)
private val StatusYellow = Color(0xFFF0C000)
private val StatusRed = Color(0xFFFA5252)
private val Accent = Color(0xFF4DABF7)

// How often the open health sheet re-scans for the daemon process (read-only).
private const val HEALTH_SHEET_REFRESH_MS = 5_000L

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
  Box(modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
      TopBar(
        status = status,
        statusDetail = statusDetail,
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
 * Pick the two device columns to compare: the focused column plus the first other observed column
 * **of the same platform**. Returns null when there is no same-platform second device, so the ⧉
 * Compare entry stays hidden and the overlay never opens with an incomparable pair. If more than
 * two same-platform devices are observed, only the focused device and one other are compared (N-way
 * compare is deferred).
 *
 * Same-platform only because the structural diff key embeds `className`, which is platform-specific
 * (`android.widget.FrameLayout` vs `XCUIElementTypeApplication`): an Android-to-iOS pair would
 * share no keys and every node would read as only-in-one, a meaningless diff. Cross-platform
 * structural-role normalization is deferred to issue #4872.
 */
internal fun compareColumns(content: WorkspaceUiState.Content): Pair<DeviceColumn, DeviceColumn>? {
  val focused =
    content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
      ?: content.columns.firstOrNull()
      ?: return null
  val other =
    content.columns.firstOrNull {
      it.deviceId != focused.deviceId && it.platform == focused.platform
    } ?: return null
  return focused to other
}

@Composable
private fun TopBar(
  status: WorkspaceStatus,
  statusDetail: String?,
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
private fun HealthSheetOverlay(onDismiss: () -> Unit, content: @Composable () -> Unit) {
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
      // Constrain the body to the height below the title row so a fillMaxSize() body can't overflow
      // the header out of the panel.
      Box(Modifier.weight(1f).fillMaxWidth()) { content() }
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
  canDiff: Boolean,
  modifier: Modifier,
) {
  Column(
    modifier =
      modifier.border(
        width = if (focused) 2.dp else 1.dp,
        color = if (focused) Accent else MaterialTheme.colorScheme.outlineVariant,
      )
  ) {
    DeviceColumnHeader(column, onAction)
    val tool = column.activeTool
    if (tool == null) {
      PaneMainContent(column, onAction, inspectContent, Modifier.weight(1f))
    } else {
      // With a tool active the pane splits main content + docked facet; ⤡ shrink flips the split so
      // the main content collapses to grow the facet.
      val facetFraction = facetHeightFraction(column.shrunk)
      PaneMainContent(column, onAction, inspectContent, Modifier.weight(1f - facetFraction))
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
  modifier: Modifier,
) {
  if (column.mode == InteractionMode.Inspect) {
    Box(modifier.fillMaxWidth()) { inspectContent(column) }
  } else {
    StreamArea(column, onAction, modifier)
  }
}

/**
 * Placeholder device stream with the emulator controls floating on it. The real WebRTC stream lands
 * in a later PR.
 */
@Composable
private fun StreamArea(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
) {
  Box(
    modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant),
    contentAlignment = Alignment.Center,
  ) {
    Text("stream", color = MaterialTheme.colorScheme.outline)
    EmulatorControls(
      column = column,
      onAction = onAction,
      modifier = Modifier.align(Alignment.TopCenter).padding(6.dp),
    )
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
 * Emulator controls floating on a device stream: rotate · screenshot · snapshot, plus a contextual
 * 🔓 Unlock shown only when the device is locked. Each is a one-shot [WorkspaceAction.RunControl].
 */
@Composable
private fun EmulatorControls(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
) {
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    // Unlock is gated on the pane's lock state; rotate/screenshot/snapshot always show. Production
    // does not yet feed DeviceColumn.locked (that needs device-state plumbing), so Unlock only
    // becomes reachable once #4694 wires the observed lock state in.
    EmulatorControl.entries
      .filter { it != EmulatorControl.Unlock || column.locked }
      .forEach { control ->
        Glyph(
          text = control.icon,
          description = "${control.label} ${column.name}",
          active = false,
          onClick = { onAction(WorkspaceAction.RunControl(column.deviceId, control)) },
        )
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
    Text(column.platform.emoji)
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
