package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.shell.UpdateReadyButton
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first

private val StatusGreen = Color(0xFF40C057)
private val StatusYellow = Color(0xFFF0C000)
private val StatusRed = Color(0xFFFA5252)
internal val Accent = Color(0xFF4DABF7)

private val LOG = LoggerFactory.getLogger("WorkspaceShell")

// How often the open health sheet re-scans for the daemon process (read-only).
internal const val HEALTH_SHEET_REFRESH_MS = 5_000L

// How long a Screenshot capture waits for the observation stream to deliver a frame before giving
// up, so a gone/unresponsive device can't leave the capture coroutine hanging.
internal const val SCREENSHOT_CAPTURE_TIMEOUT_MS = 10_000L

// How long the "saved to …" confirmation stays on the pane after a Screenshot capture.
internal const val SCREENSHOT_NOTICE_MS = 4_000L

/**
 * Root of the device-tab workspace. Device identity lives in each column header (no top tab bar); a
 * device is observed (a column) or not. This PR lands the shell, the empty state, and the column
 * chrome; real streams, emulator controls, facets, and the picker arrive in later PRs.
 */
@Composable
fun WorkspaceShell(
  state: WorkspaceUiState,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier = Modifier,
  options: WorkspaceShellOptions,
) {
  val memory = rememberWorkspaceOverlayMemory()
  with(memory) {
    return with(options) {
      val comparePair = (state as? WorkspaceUiState.Content)?.let(::compareColumns)
      // A pane closing can drop the observed count below two; retire any open compare so it can't
      // linger with a stale pair.
      if (comparePair == null && showCompare) showCompare = false
      // Offline browse is only meaningful with no device observed; if one is observed mid-browse
      // (Empty -> Content) retire the overlay so it can't linger (with its offline badge) over a
      // live
      // workspace.
      if (state !is WorkspaceUiState.Empty && showOfflineBrowse) showOfflineBrowse = false
      // A full-window overlay is open when any of the three scrimmed panels is showing. While one
      // is,
      // the workspace behind the scrim is made inert to keyboard/screen-reader focus (#4846) so a
      // Tab
      // or an assistive-tech swipe can't reach the visually-dimmed controls behind the overlay.
      // Mirror
      // the exact render conditions below so isolation tracks the overlays one-for-one.
      val overlayActive =
        showHealthSheet || (showCompare && comparePair != null) || showOfflineBrowse
      CompositionLocalProvider(
        LocalDeviceSessionSupersededHandler provides onDeviceSessionSuperseded,
      ) {
        Box(modifier.fillMaxSize()) {
          Column(Modifier.fillMaxSize().isolatedBehindOverlay(overlayActive)) {
            TopBar(
              status = status,
              statusDetail = statusDetail,
              updateStatus = updateStatus,
              options =
                TopBarActions(
                  onUpdateClick = onUpdateClick,
                  onOpenPicker = onOpenPicker,
                  onOpenPalette = onOpenPalette,
                  onStatusClick = { showHealthSheet = true },
                  canCompare = comparePair != null,
                  onCompare = { showCompare = true },
                ),
            )
            when (state) {
              is WorkspaceUiState.Empty ->
                EmptyState(
                  onOpenPicker = onOpenPicker,
                  onBrowseHistory = { showOfflineBrowse = true },
                  modifier = Modifier.weight(1f).fillMaxWidth(),
                )
              is WorkspaceUiState.Content ->
                WorkspaceColumns(state, onAction, Modifier.weight(1f).fillMaxWidth())
            }
          }
          WorkspaceOverlays(memory, comparePair)
        }
      }
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
  options: TopBarActions,
) {
  return with(options) {
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
      // ⧉ Compare opens the two-device hierarchy-diff surface; only meaningful with >1 device, so
      // it
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
      StatusDetail(status, statusDetail)
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
}

/**
 * Fraction of a pane's content height given to the docked facet when a tool is active. Shrinking
 * the pane (⤡) collapses the stream to grow the facet, so the shrunk fraction is the larger one.
 * The complement `1 - fraction` is the stream's share; both stay strictly within (0, 1) so they are
 * valid Compose weights. `internal` (not `private`) so the same-module pure test can pin the ratio.
 */
internal fun facetHeightFraction(shrunk: Boolean): Float = if (shrunk) 0.8f else 0.35f

internal fun firstPaneFraction(column: DeviceColumn): Float =
  column.firstPaneFractionOverride ?: 1f - facetHeightFraction(column.shrunk)

internal fun WorkspaceStatus.color(): Color =
  when (this) {
    WorkspaceStatus.Green -> StatusGreen
    WorkspaceStatus.Yellow -> StatusYellow
    WorkspaceStatus.Red -> StatusRed
  }

data class WorkspaceShellOptions(
  val onOpenPicker: () -> Unit,
  val status: WorkspaceStatus = WorkspaceStatus.Green,
  val statusDetail: String? = null,
  val bootstrapState: DaemonBootstrapState = DaemonBootstrapState.Inactive,
  val onRecoverDaemon: () -> Unit = {},
  val recovering: Boolean = false,
  val updateStatus: UpdateStatus = UpdateStatus.Idle,
  val onUpdateClick: () -> Unit = {},
  val onOpenPalette: () -> Unit = {},
  val onDeviceSessionSuperseded: (DeviceStreamEvent.DeviceSessionSuperseded) -> Unit = {},
  val externalCaptureRequest: Pair<String, Int>? = null,
  val facetContent: @Composable (DeviceColumn, Tool) -> Unit = { _, tool ->
    WorkspaceFacetPlaceholder(tool)
  },
  val inspectContent: @Composable (DeviceColumn) -> Unit = { LayoutFacet(LayoutFacetOptions(it)) },
  val streamContent: @Composable (DeviceColumn) -> Unit = { WorkspaceStreamPlaceholder() },
  val sessionUuidProvider: () -> String? = { null },
  val observationStreamFactory: (String) -> ObservationStream = {
    ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)
  },
  val screenshotSaver: ScreenshotSaver = RealScreenshotSaver(),
  val healthSheetContent: @Composable () -> Unit = { DefaultHealthSheetBody() },
  val compareContent: @Composable (DeviceColumn, DeviceColumn) -> Unit = { a, b ->
    TwoDeviceCompareView(
      columnA = a,
      columnB = b,
      options = DeviceCompareOptions(sessionUuidProvider = sessionUuidProvider),
    )
  },
  val offlineBrowseContent: @Composable () -> Unit = { OfflineNavigationBrowser() },
)

internal data class DeviceColumnContent(
  val displayName: String,
  val focused: Boolean,
  val facetContent: @Composable (DeviceColumn, Tool) -> Unit,
  val inspectContent: @Composable (DeviceColumn) -> Unit,
  val streamContent: @Composable (DeviceColumn) -> Unit,
  val observationStreamFactory: (String) -> ObservationStream,
  val screenshotSaver: ScreenshotSaver,
  val externalCaptureRequest: Pair<String, Int>?,
  val canDiff: Boolean,
)

internal data class DockedFacetContent(
  val facetContent: @Composable (DeviceColumn, Tool) -> Unit,
  val canDiff: Boolean,
)

internal data class HealthSheetState(
  val status: WorkspaceStatus,
  val bootstrapState: DaemonBootstrapState,
  val onRecoverDaemon: () -> Unit,
  val recovering: Boolean,
)

internal data class PaneContent(
  val inspectContent: @Composable (DeviceColumn) -> Unit,
  val streamContent: @Composable (DeviceColumn) -> Unit,
  val observationStreamFactory: (String) -> ObservationStream,
  val screenshotSaver: ScreenshotSaver,
  val externalCaptureRequest: Pair<String, Int>?,
)

internal data class StreamContent(
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
  val streamContent: @Composable (DeviceColumn) -> Unit,
  val observationStreamFactory: (String) -> ObservationStream,
  val screenshotSaver: ScreenshotSaver,
  val externalCaptureRequest: Pair<String, Int>?,
  val handledCapture: Pair<String, Int>?,
  val onHandledCapture: (Pair<String, Int>?) -> Unit,
)

internal data class TopBarActions(
  val onUpdateClick: () -> Unit,
  val onOpenPicker: () -> Unit,
  val onOpenPalette: () -> Unit,
  val onStatusClick: () -> Unit,
  val canCompare: Boolean,
  val onCompare: () -> Unit,
)

internal data class WorkspaceOverlayMemory(
  private val showHealthSheetState: androidx.compose.runtime.MutableState<Boolean>,
  private val showCompareState: androidx.compose.runtime.MutableState<Boolean>,
  private val showOfflineBrowseState: androidx.compose.runtime.MutableState<Boolean>,
) {
  var showHealthSheet by showHealthSheetState
  var showCompare by showCompareState
  var showOfflineBrowse by showOfflineBrowseState
}

@Composable
private fun rememberWorkspaceOverlayMemory(): WorkspaceOverlayMemory {
  val showHealthSheetState = remember { mutableStateOf(false) }
  val showCompareState = remember { mutableStateOf(false) }
  val showOfflineBrowseState = remember { mutableStateOf(false) }
  return WorkspaceOverlayMemory(showHealthSheetState, showCompareState, showOfflineBrowseState)
}

@Composable
private fun WorkspaceShellOptions.WorkspaceColumns(
  state: WorkspaceUiState.Content,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
) {
  Row(modifier) {
    val canDiff = state.columns.size > 1
    val displayNames = disambiguateLabels(state.columns, DeviceColumn::deviceId, DeviceColumn::name)
    state.columns.forEach { column ->
      // Key by deviceId so a surviving pane keeps its own remembered state + facet
      // connection when another pane closes (unkeyed = positional identity churns
      // survivors).
      key(column.deviceId) {
        DeviceColumnView(
          column = column,
          onAction = onAction,
          modifier = Modifier.weight(1f).fillMaxHeight(),
          options =
            DeviceColumnContent(
              displayName = displayNames.getValue(column.deviceId),
              focused = column.deviceId == state.focusedDeviceId,
              facetContent = facetContent,
              inspectContent = inspectContent,
              streamContent = streamContent,
              observationStreamFactory = observationStreamFactory,
              screenshotSaver = screenshotSaver,
              externalCaptureRequest = externalCaptureRequest,
              canDiff = canDiff,
            ),
        )
      }
    }
  }
}

@Composable
private fun WorkspaceShellOptions.WorkspaceOverlays(
  memory: WorkspaceOverlayMemory,
  comparePair: Pair<DeviceColumn, DeviceColumn>?,
) {
  with(memory) {
    if (showHealthSheet) {
      HealthSheetOverlay(
        onDismiss = { showHealthSheet = false },
        content = healthSheetContent,
        options =
          HealthSheetState(
            status = status,
            bootstrapState = bootstrapState,
            onRecoverDaemon = onRecoverDaemon,
            recovering = recovering,
          ),
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

@Composable
private fun TopBarActions.StatusDetail(status: WorkspaceStatus, statusDetail: String?) {
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
}

internal data class StreamCaptureMemory(
  private val savedNoticeState: androidx.compose.runtime.MutableState<String?>,
  private val captureRequestState: androidx.compose.runtime.MutableState<Int>,
) {
  var savedNotice by savedNoticeState
  var captureRequest by captureRequestState
}
