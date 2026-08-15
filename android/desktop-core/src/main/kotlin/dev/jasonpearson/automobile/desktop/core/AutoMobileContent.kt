@file:OptIn(
  androidx.compose.foundation.ExperimentalFoundationApi::class,
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession
import dev.jasonpearson.automobile.desktop.core.control.DeviceKeyboardEventTranslator
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceClient
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotActions
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpDeviceSnapshotActions
import dev.jasonpearson.automobile.desktop.core.daemon.McpHttpClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpVideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamSocketClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.device.DeviceControlsDashboard
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.diagnostics.DiagnosticsDashboard
import dev.jasonpearson.automobile.desktop.core.failures.DateRange
import dev.jasonpearson.automobile.desktop.core.failures.FakeFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.McpFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.StreamingFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.TimeAggregation
import dev.jasonpearson.automobile.desktop.core.layout.ConnectionStatus
import dev.jasonpearson.automobile.desktop.core.layout.DeviceControlBlockedNotice
import dev.jasonpearson.automobile.desktop.core.layout.DeviceControlTapErrorBanner
import dev.jasonpearson.automobile.desktop.core.layout.DeviceScreenView
import dev.jasonpearson.automobile.desktop.core.layout.ScreenshotMetadataOverlay
import dev.jasonpearson.automobile.desktop.core.layout.parseHierarchyFromJson
import dev.jasonpearson.automobile.desktop.core.layout.rememberLayoutInspectorState
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.AvailableEmulator
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClientFactory
import dev.jasonpearson.automobile.desktop.core.mcp.RealMcpProcessDetector
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.mcp.SystemImage
import dev.jasonpearson.automobile.desktop.core.mcp.supportsDaemonInput
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationMockData
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoader
import dev.jasonpearson.automobile.desktop.core.platform.NoOpNotificationHandler
import dev.jasonpearson.automobile.desktop.core.platform.NotificationHandler
import dev.jasonpearson.automobile.desktop.core.platform.SwingFileSaver
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsPanel
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.CommandPalette
import dev.jasonpearson.automobile.desktop.core.shell.CommandRegistry
import dev.jasonpearson.automobile.desktop.core.shell.GlobalSearchOverlay
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.shell.RightInspectorPanel
import dev.jasonpearson.automobile.desktop.core.shell.SearchCategory
import dev.jasonpearson.automobile.desktop.core.shell.SearchResult
import dev.jasonpearson.automobile.desktop.core.shell.SearchResultProvider
import dev.jasonpearson.automobile.desktop.core.shell.ThreePaneShell
import dev.jasonpearson.automobile.desktop.core.shell.buildDefaultCommands
import dev.jasonpearson.automobile.desktop.core.snapshot.SnapshotsDashboard
import dev.jasonpearson.automobile.desktop.core.storage.StorageDashboard
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import dev.jasonpearson.automobile.desktop.core.tabs.HorizontalTab
import dev.jasonpearson.automobile.desktop.core.tabs.HorizontalTabBar
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDashboard
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.matchesSearch
import dev.jasonpearson.automobile.desktop.core.test.TestDashboard
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.core.timeline.TimelineCanvas
import dev.jasonpearson.automobile.desktop.core.timeline.TimelineCategory
import dev.jasonpearson.automobile.desktop.core.timeline.activeLanes
import dev.jasonpearson.automobile.desktop.core.timeline.buildTimelineSpans
import dev.jasonpearson.automobile.desktop.core.timeline.rememberTimelineState
import dev.jasonpearson.automobile.desktop.core.video.LiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal val LOG = LoggerFactory.getLogger("AutoMobileContent")

internal fun activeDeviceConnectionLostEvent(
  event: DeviceStreamEvent,
  activeDeviceId: String?,
): DeviceStreamEvent.DeviceConnectionLost? {
  return when (event) {
    is DeviceStreamEvent.DeviceConnectionLost ->
      event.takeIf { isActiveDeviceStreamFrame(it.deviceId, activeDeviceId) }
  }
}

internal fun isActiveDeviceStreamFrame(deviceId: String?, activeDeviceId: String?): Boolean {
  return activeDeviceId != null && deviceId == activeDeviceId
}

/**
 * Device control availability and the atomic frame snapshot a click maps through now live in the
 * Compose-free [dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy] and are wired here
 * through the single [dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession] seam
 * (issue #3348). The point-gates this host used to assemble inline — device-id equality for the
 * screenshot and the hierarchy, stream liveness, and an aspect-ratio geometry check — collapsed
 * into that policy, which decides on frame *provenance* rather than on dimensions.
 */

/** Reconnect backoff bounds for [rememberLiveVideoFrame] when [autoReconnect] is on. */
internal const val LIVE_RECONNECT_INITIAL_MS = 1_000L
internal const val LIVE_RECONNECT_MAX_MS = 15_000L

/**
 * Stall watchdog for [rememberLiveVideoFrame] when [autoReconnect] is on: force a reconnect after
 * this long in `Streaming` with no frame progress. A relay that stalls with its socket OPEN (device
 * capture silently dead, half-open socket, subscriber wedged waiting for a key frame the encoder
 * never produced) keeps the state at `Streaming`, so the Unavailable-driven reconnect never fires
 * and the mirror silently freezes. A healthy-but-idle Android stream emits ~1 fps heartbeat frames
 * (FrameHeartbeat's 1s idle nudge), so ten missed seconds is decisively a stall, not idleness. The
 * reconnect is visually free: the last frame is retained while the fresh subscribe (which requests
 * an immediate key frame) replaces it.
 */
internal const val LIVE_STALL_RECONNECT_MS = 10_000L
internal const val LIVE_STALL_CHECK_INTERVAL_MS = 2_000L

/**
 * Connects a live-mirroring source for this composition and exposes only its newest frame.
 *
 * Frames arrive ready to draw — the client converts, sequences, and timestamps them on its reader
 * thread (issues #3348/#4786) — so this only conflates to the newest and gates on the stream state:
 * a frame that raced the relay's death must not restore a dead mirror. A refused or unavailable
 * relay clears the frame, allowing [DeviceScreenView] to continue rendering screenshot updates.
 *
 * With [autoReconnect] on, an `Unavailable` or recoverable permission state triggers a bounded
 * exponential-backoff [VideoStreamSource.connect] retry rather than staying dead until the pane is
 * torn down and rebuilt. This rechecks Screen Recording after the user returns from System
 * Settings. Off (the default) preserves the original clear-and-stop behavior for the IDE-plugin/
 * `AutoMobileContent` path, which blends in screenshot updates instead.
 */
@Composable
internal fun rememberLiveVideoFrame(
  source: VideoStreamSource?,
  deviceId: String?,
  autoReconnect: Boolean = false,
  reconnectInitialMs: Long = LIVE_RECONNECT_INITIAL_MS,
  nowMs: () -> Long = MONOTONIC_NOW_MS,
  stallReconnectMs: Long = LIVE_STALL_RECONNECT_MS,
  stallCheckIntervalMs: Long = LIVE_STALL_CHECK_INTERVAL_MS,
): LiveVideoFrame? {
  var liveFrame by remember(source, deviceId) { mutableStateOf<LiveVideoFrame?>(null) }

  DisposableEffect(source, deviceId) {
    if (source != null && deviceId != null) source.connect(deviceId)
    onDispose {
      liveFrame = null
      source?.dispose()
    }
  }

  LaunchedEffect(source) {
    source?.frames?.conflate()?.collect { frame ->
      if (source.state.value is VideoStreamState.Streaming) {
        liveFrame = frame
      }
    }
  }

  LaunchedEffect(source, deviceId, autoReconnect) {
    if (source == null) return@LaunchedEffect
    // collectLatest (not collect) is load-bearing for the retry: when the socket is absent,
    // connect() re-assigns the SAME Unavailable value, which MutableStateFlow suppresses — so a
    // plain collector would receive no further event and retry only once. Under collectLatest the
    // per-state block below is cancelled only by a genuine transition (Connecting/Streaming after
    // a successful connect, or disposal), so a stuck-Unavailable stream keeps retrying on its own
    // timer while a recovered one stops cleanly.
    source.state.collectLatest { state ->
      if (state is VideoStreamState.Unavailable || state is VideoStreamState.PermissionRequired) {
        // Auto-reconnecting consumers (the workspace video pane) RETAIN the last decoded frame
        // across a relay drop: the pane keeps rendering the freshest video it ever had while the
        // retry below re-subscribes, instead of flashing a non-video fallback for the whole
        // backoff window ("video pane switches to screenshots"). Freshness gating is the frame
        // consumer's job (receivedAtMs); rendering never falls back to observation screenshots.
        // The plain path (IDE plugin / AutoMobileContent) keeps the original clear-and-blend
        // semantics, where screenshot updates ARE the designed fallback surface.
        if (!autoReconnect) liveFrame = null
        if (autoReconnect && deviceId != null) {
          var backoffMs = reconnectInitialMs
          while (isActive) {
            // Cancelled by composition disposal or a real state change, so a torn-down or
            // recovered pane stops. connect() no-ops while a reader is already active, so a
            // spurious retry cannot double-subscribe.
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(LIVE_RECONNECT_MAX_MS)
            source.connect(deviceId)
          }
        }
      }
    }
  }

  // Stall watchdog (see LIVE_STALL_RECONNECT_MS): a relay that stops delivering frames while its
  // socket stays open never leaves `Streaming`, so the Unavailable-driven reconnect above cannot
  // catch it — the only observable signal is frame progress ceasing. Watch it and reconnect.
  LaunchedEffect(source, deviceId, autoReconnect) {
    if (source == null || deviceId == null || !autoReconnect) return@LaunchedEffect
    var lastProgressMs = nowMs()
    var lastSeenSequence = -1L
    while (isActive) {
      delay(stallCheckIntervalMs)
      if (source.state.value !is VideoStreamState.Streaming) {
        // Not streaming: connect/reconnect paths own recovery; restart the stall clock so a
        // fresh session gets a full window before being judged.
        lastProgressMs = nowMs()
        continue
      }
      val frame = liveFrame
      if (frame != null && frame.sequence != lastSeenSequence) {
        lastSeenSequence = frame.sequence
        lastProgressMs = frame.receivedAtMs
        continue
      }
      if (nowMs() - lastProgressMs >= stallReconnectMs) {
        LOG.info(
          "Live mirror for $deviceId made no frame progress for ${stallReconnectMs}ms " +
            "while Streaming; reconnecting"
        )
        lastProgressMs = nowMs()
        source.disconnect()
        source.connect(deviceId)
      }
    }
  }

  return liveFrame
}

/**
 * A counter that advances every [periodMs] while [enabled], used to re-run the device-control
 * availability decision on a timer (issue #3348).
 *
 * Every other input to that decision is Compose state, so a change in any of them recomposes. Frame
 * *staleness* is the exception: a stalled live relay or a daemon that stopped pushing produces no
 * state change at all, and the only thing that changes is the clock. Reading this value inside the
 * decision makes the passage of time an input like any other.
 *
 * The period is short relative to
 * [dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy .LIVE_FRAME_MAX_AGE_MS], so a
 * frozen mirror is retired promptly, and long enough to be negligible: one recomposition of the
 * live layout center per period.
 */
@Composable
internal fun rememberControlFreshnessTick(
  enabled: Boolean,
  periodMs: Long = CONTROL_FRESHNESS_TICK_MS,
): Long {
  var tick by remember { mutableStateOf(0L) }
  LaunchedEffect(enabled, periodMs) {
    if (!enabled) return@LaunchedEffect
    while (true) {
      kotlinx.coroutines.delay(periodMs)
      tick++
    }
  }
  return tick
}

/** Re-evaluation period for control freshness; see [rememberControlFreshnessTick]. */
internal const val CONTROL_FRESHNESS_TICK_MS: Long = 250L

/**
 * The clock every frame-age and refresh-deadline decision uses (issue #3348).
 *
 * Deliberately monotonic rather than wall time. `System.currentTimeMillis()` can step **backwards**
 * — NTP correction, a manual clock change, a VM or laptop resuming — and a backwards step while a
 * source is stalled makes a frame's computed age negative, so every freshness bound passes and the
 * ticker happily keeps a FROZEN mirror controllable. `System.nanoTime()` has no such step; its
 * origin is arbitrary, which is fine because only differences are ever computed from it.
 *
 * Wall time is still what the daemon stamps for display (`lastScreenshotTimestamp`); it must never
 * be mixed into an age comparison.
 */
internal val MONOTONIC_NOW_MS: () -> Long = { System.nanoTime() / 1_000_000L }

internal interface AutoMobileDeviceStreamEventSink {
  fun disconnectLayout()

  fun clearPerformanceMetrics()
}

internal class AutoMobileDeviceStreamEventHandler(
  private val activeDeviceId: () -> String?,
  private val sink: AutoMobileDeviceStreamEventSink,
) {
  fun handle(event: DeviceStreamEvent): DeviceStreamEvent.DeviceConnectionLost? {
    val lostEvent = activeDeviceConnectionLostEvent(event, activeDeviceId()) ?: return null
    sink.disconnectLayout()
    sink.clearPerformanceMetrics()
    return lostEvent
  }
}

// Notification handler is injected via parameter

enum class Dashboard(val title: String, val icon: String) {
  Navigation("Navigation", "🧭"),
  Test("Test", "🧪"),
  Performance("Performance", "⚡"),
  Layout("Layout", "📐"),
  Storage("Storage", "💾"),
  Failures("Failures", "💥"),
}

// DeviceType, BootedDevice, AvailableEmulator, SystemImage — defined in desktop.core.mcp

// Common launcher package names
private val ANDROID_LAUNCHERS =
  listOf(
    "com.google.android.apps.nexuslauncher", // Pixel Launcher
    "com.android.launcher3", // AOSP Launcher
    "com.sec.android.app.launcher", // Samsung One UI
    "com.huawei.android.launcher", // Huawei
    "com.miui.home", // Xiaomi MIUI
  )
private const val IOS_SPRINGBOARD = "com.apple.springboard"
private const val TIMELINE_EVENT_CACHE_LIMIT = 10_000

// Screenshot cadence requested while the live layout inspector is active, so the device mirror
// refreshes in near real time instead of at the daemon's 3s low-cost keepalive default (the daemon
// clamps and resolves the fastest cadence across all subscribers). When the inspector is not active
// the desktop relaxes back to the daemon default, avoiding frequent captures the user can't see.
// See issue #3333 / #3382 / #3756.
//
// Hierarchy cadence is deliberately left unset: the daemon already applies a fast per-platform
// hierarchy default (Android CtrlProxy broadcasts at 250ms, iOS polls at 1000ms) and the resolver
// takes the minimum of explicit requests, so requesting a fixed value would only risk slowing it.
private const val LIVE_SCREENSHOT_INTERVAL_MS = 1_000L

/**
 * Select the default app to show in the navigation graph. Priority: foreground app >
 * launcher/springboard > first app in list
 */
@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Text(
    text = label,
    fontSize = 10.sp,
    color = if (selected) colors.text.info else colors.text.normal.copy(alpha = 0.5f),
    modifier =
      Modifier.background(
          if (selected) colors.text.info.copy(alpha = 0.12f)
          else colors.text.normal.copy(alpha = 0.06f),
          RoundedCornerShape(12.dp),
        )
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 4.dp),
  )
}

private fun selectDefaultApp(apps: List<InstalledApp>, deviceType: DeviceType?): String? {
  // First priority: foreground app
  apps
    .find { it.isForeground }
    ?.let {
      return it.packageName
    }

  // Second priority: launcher (Android) or springboard (iOS)
  val isIOS = deviceType == DeviceType.iOSSimulator || deviceType == DeviceType.iOSPhysical
  if (isIOS) {
    apps
      .find { it.packageName == IOS_SPRINGBOARD }
      ?.let {
        return it.packageName
      }
  } else {
    // Android - try common launcher packages
    for (launcher in ANDROID_LAUNCHERS) {
      apps
        .find { it.packageName == launcher }
        ?.let {
          return it.packageName
        }
    }
  }

  // Fallback: first app in list
  return apps.firstOrNull()?.packageName
}

@Composable
fun AutoMobileContent(
  settingsProvider: SettingsProvider = FakeSettingsProvider(),
  notificationHandler: NotificationHandler = NoOpNotificationHandler,
  onOpenSource: ((String, Int, String) -> Unit)? = null,
  menuBarActions: MenuBarActions? = null,
  videoStreamSourceFactory: (() -> VideoStreamSource)? = null,
  /**
   * Opt-in device control for the live layout view (issue #3347). When true, a click on the
   * mirrored device screen in live-layout mode is mapped to a device coordinate and forwarded to
   * the daemon `input/tap` helper instead of selecting an inspector element. Defaults to false so
   * the IDE plugin (which shares this composable) stays inspector-only with no source change; the
   * reference desktop app opts in.
   */
  enableDeviceControl: Boolean = false,
) {
  // When a MenuBarActions bridge is supplied (from Main.kt's MenuBar), delegate
  // pane-visibility and overlay state to it so the native menu items and the
  // Compose keyboard shortcuts share the same mutable state.
  val actions = menuBarActions ?: remember { MenuBarActions() }
  val graph = LocalAutoMobileGraph.current

  var showSettings by actions::showSettings
  var selectedIndex by remember { mutableIntStateOf(0) }
  val dashboardOrder = remember { mutableStateListOf(*Dashboard.entries.toTypedArray()) }
  var draggedIndex by remember { mutableStateOf<Int?>(null) }
  var dropTargetIndex by remember { mutableStateOf<Int?>(null) }

  // New layout state - vertical panels (Failures, Performance) on right side
  var isFailuresPanelCollapsed by remember { mutableStateOf(true) }
  var isPerformancePanelCollapsed by remember { mutableStateOf(true) }
  var failuresPanelWidthPx by remember { mutableFloatStateOf(450f) } // 300 * 1.5
  var performancePanelWidthPx by remember { mutableFloatStateOf(450f) } // 300 * 1.5

  // Three-pane shell visibility state (delegated to MenuBarActions)
  var showLeftPane by actions::showLeftPane
  var showRightPane by actions::showRightPane
  var showBottomPane by actions::showBottomPane
  var selectedTelemetryEvent by remember { mutableStateOf<TelemetryDisplayEvent?>(null) }
  var isLiveLayoutMode by remember { mutableStateOf(false) }
  val layoutInspectorState = rememberLayoutInspectorState()

  // Last device-control input error (issues #3347, #3348). Published by DeviceControlSession from
  // the daemon's actionable error when a control-mode input fails, so the live layout view can
  // surface it; cleared on the next attempt and on every control-context reset.
  var deviceControlTapError by remember { mutableStateOf<String?>(null) }

  // Command palette & global search state (delegated to MenuBarActions)
  var showCommandPalette by actions::showCommandPalette
  var showGlobalSearch by actions::showGlobalSearch
  var showQuickJump by actions::showQuickJump

  // Theme state toggled via command palette
  var isDarkMode by remember { mutableStateOf(true) }

  // Shared telemetry event cache for global search (populated from push client)
  val telemetryEventCache = remember { mutableStateListOf<TelemetryDisplayEvent>() }

  // Command registry — populated after all state is declared below

  // Keyboard navigation state for event list
  var selectedEventIndex by remember { mutableIntStateOf(-1) }
  var vimModeEnabled by remember { mutableStateOf(false) }

  // Shared timeline state for bidirectional sync between telemetry list and timeline canvas
  val timelineState = rememberTimelineState()
  var filteredTimelineCategories by remember { mutableStateOf(emptySet<TimelineCategory>()) }

  // Horizontal tabs at bottom (Navigation, Test Runs, Storage, Diagnostics)
  val horizontalTabs = remember {
    listOf(
      HorizontalTab("test_runs", "Test Runs", AppIcons.TestRuns),
      HorizontalTab("storage", "Storage", AppIcons.Storage),
      HorizontalTab("snapshots", "Snapshots", AppIcons.Snapshots),
      HorizontalTab("device_controls", "Device", AppIcons.DeviceControls),
      HorizontalTab("diagnostics", "Diagnostics", AppIcons.Diagnostics),
    )
  }
  var selectedHorizontalTabId by remember { mutableStateOf<String?>(null) }

  // Track live performance metrics for collapsed Performance panel
  var currentFps by remember { mutableStateOf<Float?>(null) }
  var currentFrameTimeMs by remember { mutableStateOf<Float?>(null) }
  var currentJankFrames by remember { mutableStateOf<Int?>(null) }
  var currentMemoryMb by remember { mutableStateOf<Float?>(null) }
  var currentTouchLatencyMs by remember { mutableStateOf<Float?>(null) }
  var currentRecompositionRate by remember { mutableStateOf<Float?>(null) }
  var perfUpdateCounter by remember { mutableIntStateOf(0) }
  fun clearPerformanceMetrics() {
    currentFps = null
    currentFrameTimeMs = null
    currentJankFrames = null
    currentMemoryMb = null
    currentTouchLatencyMs = null
    currentRecompositionRate = null
  }

  // Track failure counts by type for collapsed Failures panel
  var crashCount by remember { mutableIntStateOf(0) }
  var anrCount by remember { mutableIntStateOf(0) }
  var toolFailureCount by remember { mutableIntStateOf(0) }
  var nonFatalCount by remember { mutableIntStateOf(0) }
  var hasNewCriticalFailure by remember { mutableStateOf(false) }

  // Load persisted date range setting
  val settings = remember { settingsProvider }
  var failuresDateRange by remember {
    val saved = settingsProvider.failuresDateRange
    val initial = DateRange.entries.find { it.label == saved } ?: DateRange.TwentyFourHours
    mutableStateOf(initial)
  }

  // Mock booted devices - will be replaced with real data
  val activeDeviceIdState = remember {
    mutableStateOf<String?>(null)
  } // null = show MCP panel in Real mode
  val isDevicePanelExpandedState = remember {
    mutableStateOf(true)
  } // Start expanded to show MCP servers
  var activeDeviceId by activeDeviceIdState
  var isDevicePanelExpanded by isDevicePanelExpandedState

  // Track when user explicitly navigates to device panel (to suppress auto-selection)
  var userNavigatedToDevices by remember { mutableStateOf(false) }

  // Log state changes for debugging
  LaunchedEffect(activeDeviceId, isDevicePanelExpanded) {
    LOG.info(
      "State changed: activeDeviceId=$activeDeviceId, isDevicePanelExpanded=$isDevicePanelExpanded"
    )
  }

  // Data source mode (Fake/Real) - global toggle for all dashboards
  var dataSourceMode by remember { mutableStateOf(DataSourceMode.Real) }

  // Pending failure ID for deep linking from notifications
  var pendingFailureId by remember { mutableStateOf<String?>(null) }

  // App selector state (for Navigation dashboard filtering)
  var selectedAppId by remember { mutableStateOf<String?>(null) }
  var installedApps by remember { mutableStateOf<List<InstalledApp>>(emptyList()) }
  var isAppListLoading by remember { mutableStateOf(false) }
  var appDropdownExpanded by remember { mutableStateOf(false) }

  // Mock devices list (only used in Fake mode)
  val mockBootedDevices = remember {
    listOf(
      BootedDevice(
        "pixel8",
        "Pixel 8 API 35",
        DeviceType.AndroidEmulator,
        "Running",
        "com.example.myapp",
        System.currentTimeMillis() - 300000,
      ),
      BootedDevice(
        "pixel7",
        "Pixel 7 API 34",
        DeviceType.AndroidEmulator,
        "Running",
        "com.android.launcher3",
        System.currentTimeMillis() - 600000,
      ),
      BootedDevice(
        "iphone15",
        "iPhone 15 Pro",
        DeviceType.iOSSimulator,
        "Booted",
        "com.apple.springboard",
        System.currentTimeMillis() - 180000,
      ),
    )
  }

  // Real device info (when connected to MCP)
  var realDevice by remember { mutableStateOf<BootedDevice?>(null) }
  var realDevices by remember { mutableStateOf<List<BootedDevice>>(emptyList()) }
  var deviceImages by remember {
    mutableStateOf<List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>>(emptyList())
  }

  // Connected MCP process (for creating clients)
  var connectedMcpProcess by remember { mutableStateOf<McpProcess?>(null) }

  // Counter to trigger MCP process re-detection (incremented by Connect button)
  var mcpConnectRetryCounter by remember { mutableIntStateOf(0) }

  // Log when connectedMcpProcess changes
  LaunchedEffect(connectedMcpProcess) {
    LOG.info(
      "connectedMcpProcess changed to: ${connectedMcpProcess?.let { "${it.name} (PID ${it.pid}, ${it.connectionType})" } ?: "null"}"
    )
  }

  // Auto-detect and connect to MCP process when in Real mode
  LaunchedEffect(dataSourceMode, connectedMcpProcess, mcpConnectRetryCounter) {
    if (dataSourceMode == DataSourceMode.Real && connectedMcpProcess == null) {
      kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val detector = RealMcpProcessDetector()
        val processes = detector.detectProcesses()
        LOG.info("Auto-detect MCP: found ${processes.size} process(es)")
        val preferred =
          processes.firstOrNull { it.connectionType == McpConnectionType.UnixSocket }
            ?: processes.firstOrNull { it.connectionType == McpConnectionType.StreamableHttp }
        if (preferred != null) {
          LOG.info(
            "Auto-connecting to MCP process: ${preferred.name} (PID ${preferred.pid}, ${preferred.connectionType})"
          )
          connectedMcpProcess = preferred
        }
      }
    }
  }

  // One stable identity and long-lived client per connected Unix daemon. The stream sockets only
  // read the daemon session registry; they never create or bind a session themselves.
  val desktopDaemonSession: DesktopDaemonSession? =
    remember(connectedMcpProcess, dataSourceMode) {
      val process = connectedMcpProcess
      if (
        dataSourceMode == DataSourceMode.Real &&
          process?.connectionType == McpConnectionType.UnixSocket
      ) {
        DesktopDaemonSession.create(process.socketPath ?: DaemonSocketPaths.socketPath())
      } else {
        null
      }
    }

  val desktopSessionCleanupScope =
    remember(desktopDaemonSession) {
      desktopDaemonSession?.let { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    }

  DisposableEffect(desktopDaemonSession, desktopSessionCleanupScope) {
    onDispose {
      if (desktopDaemonSession != null && desktopSessionCleanupScope != null) {
        desktopSessionCleanupScope.launch {
          runCatching { desktopDaemonSession.release() }
            .onFailure { error ->
              LOG.warn("Failed to release desktop daemon session: ${error.message}")
            }
          desktopSessionCleanupScope.cancel()
        }
      }
    }
  }

  // Client provider function for dashboards to access MCP data
  val clientProvider: (() -> AutoMobileClient)? =
    remember(connectedMcpProcess, dataSourceMode, desktopDaemonSession) {
      LOG.info(
        "clientProvider being computed, connectedMcpProcess=${connectedMcpProcess?.let { "${it.name} (PID ${it.pid})" } ?: "null"}"
      )
      connectedMcpProcess?.let { process ->
        {
          when (process.connectionType) {
            McpConnectionType.UnixSocket ->
              desktopDaemonSession?.client
                ?: McpDaemonClient(process.socketPath ?: DaemonSocketPaths.socketPath())
            McpConnectionType.StreamableHttp -> {
              val port = process.port ?: 3000
              McpHttpClient("http://localhost:$port/auto-mobile/streamable")
            }
            McpConnectionType.Stdio -> {
              throw UnsupportedOperationException("Cannot connect to STDIO process externally")
            }
          }
        }
      }
    }

  var desktopSessionBoundDeviceId by
    remember(desktopDaemonSession) {
      mutableStateOf<String?>(null)
    }
  val desktopSessionBindingMutex = remember(desktopDaemonSession) { Mutex() }
  val desktopSessionBindingGeneration = remember(desktopDaemonSession) { AtomicLong(0L) }
  val desktopSessionReady = desktopSessionBoundDeviceId == activeDeviceId && activeDeviceId != null

  LaunchedEffect(desktopDaemonSession, desktopSessionBoundDeviceId) {
    if (desktopDaemonSession == null || desktopSessionBoundDeviceId == null) return@LaunchedEffect
    while (isActive) {
      delay(2_000)
      runCatching {
        withContext(Dispatchers.IO) { desktopDaemonSession.heartbeat() }
      }
        .onFailure { error ->
          LOG.warn("Failed to refresh desktop daemon session: ${error.message}")
        }
    }
  }

  // Register and bind the selected device before creating authenticated stream clients. A
  // stream-socket getSession lookup is read-only, so the main-socket tool call must happen first.
  LaunchedEffect(dataSourceMode, activeDeviceId, realDevice, clientProvider, desktopDaemonSession) {
    val bindingGeneration = desktopSessionBindingGeneration.incrementAndGet()
    val selectedDeviceId = activeDeviceId
    desktopSessionBoundDeviceId = null
    if (
      dataSourceMode != DataSourceMode.Real || selectedDeviceId == null || clientProvider == null
    ) {
      return@LaunchedEffect
    }

    if (desktopDaemonSession == null) {
      // Non-Unix transports retain their existing behavior; stream auth is a Unix-daemon concern.
      desktopSessionBoundDeviceId = selectedDeviceId
      return@LaunchedEffect
    }

    val platform =
      if (
        realDevice?.type == DeviceType.iOSSimulator || realDevice?.type == DeviceType.iOSPhysical
      ) {
        "ios"
      } else {
        "android"
      }
    try {
      // Socket calls are synchronous and cannot be interrupted while a daemon is responding.
      // Serialize them so a cancelled, stale request cannot overwrite a newer device binding.
      desktopSessionBindingMutex.withLock {
        kotlinx.coroutines.withContext(Dispatchers.IO) {
          clientProvider.invoke().setActiveDevice(selectedDeviceId, platform)
        }
      }
      if (desktopSessionBindingGeneration.get() == bindingGeneration) {
        desktopSessionBoundDeviceId = selectedDeviceId
      }
      LOG.info(
        "Registered desktop daemon session ${desktopDaemonSession.sessionUuid} for device $selectedDeviceId"
      )
    } catch (error: Exception) {
      LOG.warn("Failed to register desktop daemon session for $selectedDeviceId: ${error.message}")
    }
  }

  // Device snapshots span two transports: the verbs are MCP tool/resource calls, while the
  // retention config is its own Unix socket. Both are null in Fake mode so the dashboard renders
  // its empty state instead of reaching for a daemon that isn't there.
  val snapshotActions: DeviceSnapshotActions? =
    remember(clientProvider) { clientProvider?.let { McpDeviceSnapshotActions(it) } }
  val snapshotConfigClient: DeviceSnapshotConfigClient? =
    remember(dataSourceMode) {
      if (dataSourceMode == DataSourceMode.Real) DeviceSnapshotSocketClient() else null
    }

  // Appearance and video recording follow the same split: config over their own sockets, verbs
  // over the MCP client.
  val appearanceClient: AppearanceClient? =
    remember(dataSourceMode) {
      if (dataSourceMode == DataSourceMode.Real) AppearanceSocketClient() else null
    }
  val recordingConfigClient: VideoRecordingConfigClient? =
    remember(dataSourceMode) {
      if (dataSourceMode == DataSourceMode.Real) VideoRecordingSocketClient() else null
    }
  val recordingActions: VideoRecordingActions? =
    remember(clientProvider) { clientProvider?.let { McpVideoRecordingActions(it) } }
  // Screen sharing is daemon-side publishing, so it needs no MCP client -- just the socket.
  val webRtcStreamClient: WebRtcStreamClient? =
    remember(dataSourceMode, desktopDaemonSession, desktopSessionReady) {
      if (
        dataSourceMode == DataSourceMode.Real &&
          (desktopDaemonSession == null || desktopSessionReady)
      ) {
        WebRtcStreamSocketClient(
          sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null }
        )
      } else {
        null
      }
    }

  val liveVideoSource =
    remember(activeDeviceId, dataSourceMode, isLiveLayoutMode, desktopSessionReady) {
      if (
        dataSourceMode == DataSourceMode.Real &&
          isLiveLayoutMode &&
          activeDeviceId != null &&
          desktopSessionReady
      ) {
        videoStreamSourceFactory?.invoke()
          ?: VideoStreamClient(
            sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null }
          )
      } else {
        null
      }
    }
  val liveVideoFrame = rememberLiveVideoFrame(liveVideoSource, activeDeviceId)
  // Forces the control-availability decision to be re-evaluated on a timer, not only when an
  // observation source produces an update (issue #3348). A stalled observation stream produces
  // nothing at all — its staleness is visible only as time passing — so without this a frozen
  // screenshot would stay clickable until some unrelated recomposition happened to run.
  val controlFreshnessTick = rememberControlFreshnessTick(enableDeviceControl && isLiveLayoutMode)

  // Take-screenshot is driven from both the native menu bar and the in-app menu.
  // Run it on a composition-scoped coroutine (not GlobalScope) so the call and its
  // MCP client are cancelled when this composable leaves composition instead of
  // leaking a hung coroutine + client if the daemon is unresponsive (#3603).
  val screenshotScope = rememberCoroutineScope()

  // The daemon platform string for the selected device. Held in state because the device list (and
  // therefore the platform) resolves later in this composable than the control session, which must
  // exist before the stream effects that reset it.
  val controlPlatform = remember { mutableStateOf("android") }

  // The ONE device-control seam (issue #3348). It owns the ordered bounded dispatch queue, the
  // error-ordering claim, the availability decision and the post-input refresh tracker, so this
  // host wires control once instead of assembling a gate per discovered source disagreement.
  // Drag/swipe (#3350) and keyboard/text (#3351) add a dispatch method to the session rather than
  // new wiring here.
  // The daemon client factory the session mints per-tap clients from, held in state so it can be
  // SWAPPED behind one long-lived session. Rebuilding the session on every provider change (a
  // daemon reconnect) would strand the previous session's dispatch consumer inside the stable
  // screenshotScope: taps queued behind a blocked request would drain through the superseded
  // client once it unblocked, and that session's independent error claim could publish a banner
  // into the new context.
  val controlClientProvider by rememberUpdatedState(clientProvider)
  val deviceControlSession =
    remember(screenshotScope) {
      DeviceControlSession(
        scope = screenshotScope,
        clientProvider = { controlClientProvider?.invoke() },
        platform = { controlPlatform.value },
        nowMs = MONOTONIC_NOW_MS,
        publishError = { message -> deviceControlTapError = message },
      )
    }

  // The provider swaps behind the session via rememberUpdatedState; this drops everything captured
  // against the PREVIOUS provider — the queued backlog (closing each pending client, so a
  // superseded dispatcher can never hold unclosed AutoMobileClient instances), the error claim, and
  // any pending post-input refresh wait.
  LaunchedEffect(clientProvider) { deviceControlSession.reset() }

  // One coherent reset of the control context (issues #3347, #3348), run at every point that
  // invalidates the rendered frame identity (device change, transport/mode change, stream
  // disconnect, Live Layout open/close). See DeviceControlSession.reset.
  val resetControlTapContext: () -> Unit = { deviceControlSession.reset() }

  // Whether the mirrored device canvas holds the keyboard (issue #3351). Reported by
  // DeviceScreenView; consumed by the shell so its preview navigation handler stands aside while
  // the device owns un-chorded keys.
  var deviceCanvasFocused by remember { mutableStateOf(false) }

  val takeScreenshot: () -> Unit =
    remember(clientProvider, screenshotScope) {
      takeScreenshot@{
        val provider = clientProvider ?: return@takeScreenshot
        screenshotScope.launch(Dispatchers.IO) {
          val client = provider()
          try {
            client.callTool("screenshot", buildJsonObject {})
          } catch (e: Exception) {
            LOG.warn("Screenshot request failed: ${e.message}")
          } finally {
            client.close()
          }
        }
      }
    }

  // Register the screenshot callback on the shared MenuBarActions bridge so the
  // native menu bar "Take Screenshot" item can trigger it.
  DisposableEffect(takeScreenshot) {
    actions.onTakeScreenshot = takeScreenshot
    onDispose { actions.onTakeScreenshot = null }
  }

  // After MCP auto-connect, fetch booted devices and populate realDevice for the sidebar
  LaunchedEffect(connectedMcpProcess) {
    val process = connectedMcpProcess ?: return@LaunchedEffect
    kotlinx.coroutines.withContext(Dispatchers.IO) {
      try {
        val client = McpResourceClientFactory.create(process)
        try {
          when (val result = client.readResource("automobile:devices/booted")) {
            is ResourceReadResult.Success -> {
              val parsed = DeviceResourceParser.parseBootedDevices(result.content)
              val allDevices = parsed?.devices ?: emptyList()
              val allBootedDevices = allDevices.map { dev ->
                val deviceType =
                  when {
                    dev.platform == "ios" && dev.isVirtual -> DeviceType.iOSSimulator
                    dev.platform == "ios" -> DeviceType.iOSPhysical
                    dev.isVirtual -> DeviceType.AndroidEmulator
                    else -> DeviceType.AndroidPhysical
                  }
                BootedDevice(
                  id = dev.deviceId,
                  name = dev.name,
                  type = deviceType,
                  status = dev.status,
                )
              }
              realDevices = allBootedDevices
              val firstDevice = allBootedDevices.firstOrNull()
              if (firstDevice != null) {
                realDevice = firstDevice
                activeDeviceId = firstDevice.id
                LOG.info(
                  "Set realDevice from MCP: ${firstDevice.name} (${firstDevice.id}), total devices: ${allBootedDevices.size}"
                )
              }
            }
            is ResourceReadResult.Error -> {
              LOG.info("Failed to fetch booted devices after MCP connect: ${result.message}")
            }
          }
        } finally {
          client.close()
        }
      } catch (e: Exception) {
        LOG.info("Error fetching booted devices after MCP connect: ${e.message}")
      }
      // Also fetch device images
      try {
        val client = McpResourceClientFactory.create(process)
        try {
          when (val result = client.readResource("automobile:devices/images")) {
            is ResourceReadResult.Success -> {
              val parsed = DeviceResourceParser.parseDeviceImages(result.content)
              deviceImages = parsed?.images ?: emptyList()
            }
            is ResourceReadResult.Error -> {}
          }
        } finally {
          client.close()
        }
      } catch (_: Exception) {}
    }
  }

  // Poll device lists to detect boot/kill changes, with backoff on consecutive failures
  LaunchedEffect(connectedMcpProcess) {
    val process = connectedMcpProcess ?: return@LaunchedEffect
    var consecutiveFailures = 0
    val baseDelayMs = 5000L
    val maxDelayMs = 60000L
    while (true) {
      val delayMs =
        if (consecutiveFailures <= 1) baseDelayMs
        else
          (baseDelayMs * (1L shl (consecutiveFailures - 1).coerceAtMost(4))).coerceAtMost(
            maxDelayMs
          )
      kotlinx.coroutines.delay(delayMs)
      kotlinx.coroutines.withContext(Dispatchers.IO) {
        try {
          val client = McpResourceClientFactory.create(process)
          try {
            when (val result = client.readResource("automobile:devices/booted")) {
              is ResourceReadResult.Success -> {
                consecutiveFailures = 0
                val parsed = DeviceResourceParser.parseBootedDevices(result.content)
                val allDevices = parsed?.devices ?: emptyList()
                val newDevices =
                  allDevices
                    .filter { it.name != "Unknown" && it.status == "booted" }
                    .map { dev ->
                      val deviceType =
                        when {
                          dev.platform == "ios" && dev.isVirtual -> DeviceType.iOSSimulator
                          dev.platform == "ios" -> DeviceType.iOSPhysical
                          dev.isVirtual -> DeviceType.AndroidEmulator
                          else -> DeviceType.AndroidPhysical
                        }
                      BootedDevice(
                        id = dev.deviceId,
                        name = dev.name,
                        type = deviceType,
                        status = dev.status,
                      )
                    }
                realDevices = newDevices
                // Clear active device if it's no longer in the list
                if (activeDeviceId != null && newDevices.none { it.id == activeDeviceId }) {
                  activeDeviceId = null
                  realDevice = null
                }
              }
              is ResourceReadResult.Error -> {
                consecutiveFailures++
              }
            }
            when (val result = client.readResource("automobile:devices/images")) {
              is ResourceReadResult.Success -> {
                val parsed = DeviceResourceParser.parseDeviceImages(result.content)
                deviceImages = parsed?.images ?: emptyList()
              }
              is ResourceReadResult.Error -> {}
            }
          } finally {
            client.close()
          }
        } catch (e: Exception) {
          consecutiveFailures++
          if (consecutiveFailures == 1) {
            LOG.info("Device polling failed, will retry with backoff: ${e.message}")
          }
        }
      }
    }
  }

  // Observation stream client for real-time hierarchy/screenshot updates
  // Only created when a device is connected; disposed when device disconnects
  var observationStreamClient by remember { mutableStateOf<ObservationStreamClient?>(null) }

  // Feed stream data into the shared layout inspector state for live layout mode
  val liveStreamClient = observationStreamClient
  LaunchedEffect(liveStreamClient, isLiveLayoutMode, activeDeviceId) {
    if (!isLiveLayoutMode || liveStreamClient == null) return@LaunchedEffect
    // Drop any buffered pre-(re)subscribe frame so a Live Layout reopen doesn't replay the stale
    // pre-close frame and re-arm control from it (issue #3347). Only genuinely post-subscribe
    // frames
    // arm control.
    liveStreamClient.resetLayoutReplayCache()
    liveStreamClient.hierarchyUpdates.collect { update ->
      if (!isActiveDeviceStreamFrame(update.deviceId, activeDeviceId)) return@collect
      deviceControlSession.onObservationFrameContextDeclared(
        update.frameContext,
        update.captureSequence,
      )
      // AT RECEIPT, before the parse below and before the layout state's debounce: the daemon has
      // already switched to interpreting input under the new scale metadata by the time it
      // publishes a new declaration, so a flip has to invalidate control NOW. Detecting it from
      // the frame facts would be one debounce interval too late, and a tap in that window would be
      // mapped in the old unit and converted as the new one (issue #4550).
      deviceControlSession.onObservationSpaceDeclared(
        update.coordinateSpace,
        update.captureSequence,
        update.nativeScale,
      )
      // Capture the generation before the async parse so a frame decoded across an invalidation
      // (device change / stream disconnect) is dropped instead of restoring stale bounds (#3347).
      val generation = layoutInspectorState.frameGeneration
      update.data?.let { hierarchyJson ->
        val result =
          kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            val parsed = parseHierarchyFromJson(hierarchyJson) ?: return@withContext null
            val changedIds =
              layoutInspectorState.computeChangedElements(
                layoutInspectorState.currentElementMap,
                parsed.elementMap,
              )
            parsed to changedIds
          }
        result?.let {
          layoutInspectorState.updateConnectionStatus(ConnectionStatus.Connected)
          // Tag the hierarchy with its source device so the device-control gate can require the
          // hit-tested hierarchy (not just the screenshot) to match the selected device (issue
          // #3347). The frame already passed the active-device filter above.
          layoutInspectorState.applyHierarchyUpdate(
            it.first,
            it.second,
            deviceId = update.deviceId,
            generation = generation,
            // The daemon's shared capture id is this update's provenance: device control pairs it
            // by EQUALITY against the screenshot update's id, so a hierarchy left behind by a
            // resolution change can never supply the bounds a tap is mapped through — however few
            // milliseconds behind it is (issue #3348).
            captureSequence = update.captureSequence,
            frameContext = update.frameContext,
            // The unit this update's bounds are in, as the daemon declared it. Carried per update
            // rather than per session because the declaration is per message, and the control
            // policy only compares dimensions exactly when the paired screenshot declared the same
            // thing (issue #4550).
            coordinateSpace = update.coordinateSpace,
            nativeScale = update.nativeScale,
            captureRotation = update.rotation,
          )
        }
      }
    }
  }
  LaunchedEffect(liveStreamClient, isLiveLayoutMode, activeDeviceId) {
    if (!isLiveLayoutMode || liveStreamClient == null) return@LaunchedEffect
    // See the hierarchy collector: drop the buffered replay before resubscribing so a reopen can't
    // re-arm control from a stale pre-close screenshot (issue #3347).
    liveStreamClient.resetLayoutReplayCache()
    liveStreamClient.screenshotUpdates.collect { update ->
      if (!isActiveDeviceStreamFrame(update.deviceId, activeDeviceId)) return@collect
      deviceControlSession.onObservationFrameContextDeclared(
        update.frameContext,
        update.captureSequence,
      )
      // Same receipt-time gate as the hierarchy collector; see its comment (issue #4550).
      deviceControlSession.onObservationSpaceDeclared(
        update.coordinateSpace,
        update.captureSequence,
        update.nativeScale,
      )
      // Capture the generation before the async decode so a screenshot decoded across an
      // invalidation (device change / stream disconnect) is dropped rather than restoring a stale
      // frame that would silently re-enable device control (#3347).
      val generation = layoutInspectorState.frameGeneration
      update.screenshotBase64?.let { base64 ->
        val screenshotData =
          kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            java.util.Base64.getDecoder().decode(base64)
          }
        layoutInspectorState.updateConnectionStatus(ConnectionStatus.Connected)
        layoutInspectorState.updateScreenshot(
          data = screenshotData,
          width = update.screenWidth,
          height = update.screenHeight,
          timestamp = update.timestamp,
          fallback = update.screenshotFallback ?: false,
          fallbackReason = update.screenshotFallbackReason,
          format = update.screenshotFormat,
          captureSource = update.screenshotCaptureSource,
          // Tag the rendered frame with its source device so device control can require the
          // on-screen frame to match the selected device (issue #3347). The frame already passed
          // the
          // active-device filter above, so this equals activeDeviceId at apply time.
          deviceId = update.deviceId,
          generation = generation,
          // Pairs by equality against the hierarchy's id; see the hierarchy collector above.
          captureSequence = update.captureSequence,
          frameContext = update.frameContext,
          // Same reasoning as the hierarchy collector: the declared unit travels with the frame
          // (issue #4550).
          coordinateSpace = update.coordinateSpace,
          nativeScale = update.nativeScale,
          rotation = update.rotation,
        )
      }
    }
  }

  // Push socket client for real-time failure notifications
  // Only created when a device is connected in Real mode; disposed when device disconnects
  var failuresPushClient by remember { mutableStateOf<FailuresPushSocketClient?>(null) }

  // Push socket client for real-time telemetry events
  // Only created when a device is connected in Real mode; disposed when device disconnects
  var telemetryPushClient by remember { mutableStateOf<TelemetryPushClient?>(null) }

  // Streaming failures data source for real-time failure notifications
  // Only created in Real mode when the Failures panel is expanded
  val streamingFailuresDataSource =
    remember(dataSourceMode, isFailuresPanelCollapsed) {
      if (dataSourceMode == DataSourceMode.Real && !isFailuresPanelCollapsed)
        StreamingFailuresDataSource()
      else null
    }

  // Fetch initial failure counts (deferred until a device is connected)
  LaunchedEffect(dataSourceMode, failuresDateRange, clientProvider, activeDeviceId) {
    if (dataSourceMode == DataSourceMode.Real && clientProvider == null) return@LaunchedEffect
    if (dataSourceMode == DataSourceMode.Fake && activeDeviceId == null) return@LaunchedEffect
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
      try {
        val dataSource =
          when (dataSourceMode) {
            DataSourceMode.Fake -> FakeFailuresDataSource()
            DataSourceMode.Real -> clientProvider?.let { McpFailuresDataSource(it) }
          }
        if (dataSource != null) {
          // Use appropriate aggregation for the selected date range
          val aggregation =
            when (failuresDateRange) {
              DateRange.OneHour -> TimeAggregation.Minute
              DateRange.TwentyFourHours -> TimeAggregation.Hour
              DateRange.ThreeDays -> TimeAggregation.Hour
              DateRange.SevenDays -> TimeAggregation.Day
              DateRange.ThirtyDays -> TimeAggregation.Day
            }
          when (val result = dataSource.getTimelineData(failuresDateRange, aggregation)) {
            is Result.Success -> {
              val data = result.data
              crashCount = data.dataPoints.sumOf { it.crashes }
              anrCount = data.dataPoints.sumOf { it.anrs }
              toolFailureCount = data.dataPoints.sumOf { it.toolFailures }
              nonFatalCount = data.dataPoints.sumOf { it.nonfatals }
            }
            is Result.Error -> {
              // Keep zeros on error
            }
            is Result.Loading -> {
              /* waiting for data */
            }
          }
        }
      } catch (e: Exception) {
        LOG.warn("Failed to fetch initial failure counts", e)
      }
    }
  }

  // Create, connect, and dispose socket clients based on active device and data source mode.
  // Clients are only allocated when a device is connected, eliminating startup overhead.
  DisposableEffect(activeDeviceId, dataSourceMode) {
    val deviceId = activeDeviceId
    var obsClient: ObservationStreamClient? = null
    var failClient: FailuresPushSocketClient? = null
    var telClient: TelemetryPushSocketClient? = null

    if (deviceId != null) {
      obsClient = ObservationStreamClient()
      LOG.info(
        "Connecting observation stream for device: $deviceId (client: ${obsClient.hashCode()})"
      )
      // Cadence starts at the daemon default; the focus-aware effect below raises it while the
      // live layout inspector is active and relaxes it otherwise.
      obsClient.connect(deviceId = deviceId)
      observationStreamClient = obsClient

      if (dataSourceMode == DataSourceMode.Real) {
        failClient = FailuresPushSocketClient()
        LOG.info("Connecting failures push client")
        failClient.connect()
        failuresPushClient = failClient

        telClient = TelemetryPushSocketClient()
        LOG.info("Connecting telemetry push client for device: $deviceId")
        telClient.connect(deviceId = deviceId)
        telemetryPushClient = telClient
      }
    }

    onDispose {
      if (obsClient != null) {
        LOG.info("Disposing observation stream client (was connected to: $deviceId)")
        observationStreamClient = null
        obsClient.dispose()
      }
      if (failClient != null) {
        LOG.info("Disposing failures push client")
        failuresPushClient = null
        failClient.dispose()
      }
      if (telClient != null) {
        LOG.info("Disposing telemetry push client")
        telemetryPushClient = null
        telClient.dispose()
      }
    }
  }

  // Periodic connection health check - reconnect if connection dropped
  LaunchedEffect(observationStreamClient) {
    val client = observationStreamClient ?: return@LaunchedEffect
    val deviceId = activeDeviceId ?: return@LaunchedEffect
    while (true) {
      kotlinx.coroutines.delay(5000)
      if (!client.isConnected()) {
        if (!ObservationStreamClient.socketExists()) {
          LOG.info("Observation stream socket missing, daemon appears down - skipping reconnect")
        } else {
          LOG.info("Observation stream disconnected, attempting reconnect for device: $deviceId")
          // connect() re-applies the cadence last set via setCadence, preserving it across
          // reconnects.
          client.connect(deviceId = deviceId)
        }
      }
    }
  }

  // Focus-aware observation cadence: request a fast screenshot cadence only while the live layout
  // inspector is active, and relax to the daemon default otherwise, so the daemon isn't driving
  // frequent screenshot captures when the mirror isn't on screen. setCadence is a no-op when the
  // value is unchanged, so re-firing on unrelated recompositions is cheap.
  LaunchedEffect(observationStreamClient, isLiveLayoutMode) {
    val client = observationStreamClient ?: return@LaunchedEffect
    client.setCadence(
      screenshotIntervalMs = if (isLiveLayoutMode) LIVE_SCREENSHOT_INTERVAL_MS else null
    )
  }

  // Periodic connection health check for failures push - reconnect if dropped
  LaunchedEffect(failuresPushClient) {
    val client = failuresPushClient ?: return@LaunchedEffect
    while (true) {
      kotlinx.coroutines.delay(5000)
      if (!client.isConnected()) {
        LOG.info("Failures push disconnected, attempting reconnect")
        client.connect()
      }
    }
  }

  // Periodic connection health check for telemetry push - reconnect if dropped
  LaunchedEffect(telemetryPushClient) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    while (true) {
      kotlinx.coroutines.delay(5000)
      if (!client.isConnected()) {
        if (!TelemetryPushSocketClient.socketExists()) {
          LOG.info("Telemetry push socket missing, daemon appears down - skipping reconnect")
        } else {
          LOG.info("Telemetry push disconnected, attempting reconnect")
          client.connect()
        }
      }
    }
  }

  // Listen for hierarchy updates to update foreground app state in real-time
  LaunchedEffect(observationStreamClient) {
    val client = observationStreamClient ?: return@LaunchedEffect
    client.hierarchyUpdates.collect { update ->
      val newForegroundApp = update.packageName
      if (newForegroundApp != null && installedApps.isNotEmpty()) {
        // Check if foreground app changed
        val currentForeground = installedApps.find { it.isForeground }?.packageName
        if (currentForeground != newForegroundApp) {
          LOG.info("Foreground app changed: $currentForeground -> $newForegroundApp")
          // Update the installed apps list with new foreground state
          installedApps = installedApps.map { app ->
            app.copy(isForeground = app.packageName == newForegroundApp)
          }
        }
      }
    }
  }

  // Listen for performance updates to update collapsed Performance panel summary
  LaunchedEffect(observationStreamClient) {
    val client = observationStreamClient ?: return@LaunchedEffect
    client.performanceUpdates.collect { update ->
      currentFps = update.fps
      currentFrameTimeMs = update.frameTimeMs
      currentJankFrames = update.jankFrames
      currentMemoryMb = update.memoryUsageMb
      currentTouchLatencyMs = update.touchLatencyMs
      currentRecompositionRate = update.recompositionRate
      perfUpdateCounter++
    }
  }

  // Device-side CtrlProxy disconnects arrive as stream events while the daemon socket can remain
  // connected. Clear the production live layout state immediately so the UI cannot keep showing a
  // stale last frame for the active device.
  LaunchedEffect(observationStreamClient, activeDeviceId) {
    val client = observationStreamClient ?: return@LaunchedEffect
    val clearLivePerformanceMetrics = { clearPerformanceMetrics() }
    val eventHandler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { activeDeviceId },
        sink =
          object : AutoMobileDeviceStreamEventSink {
            override fun disconnectLayout() {
              layoutInspectorState.disconnect()
              resetControlTapContext()
            }

            override fun clearPerformanceMetrics() {
              clearLivePerformanceMetrics()
            }
          },
      )
    client.deviceEvents.collect { event ->
      val lostEvent = eventHandler.handle(event) ?: return@collect
      LOG.warn("Device connection lost for ${lostEvent.deviceId}: ${lostEvent.error}")
    }
  }

  // Clear performance metrics when stream disconnects
  LaunchedEffect(observationStreamClient) {
    val client = observationStreamClient ?: return@LaunchedEffect
    client.connectionState.collect { connectionState ->
      if (connectionState is ConnectionState.Disconnected) {
        clearPerformanceMetrics()
        // The observation stream is dead, so the on-screen mirror is frozen/stale even if the input
        // socket still works. Mark it disconnected AND invalidate the rendered frame's device
        // identity so device control deactivates (issue #3347) — a click on a frozen mirror must
        // not
        // actuate the real device. The generation bump inside the invalidation also drops any
        // decode
        // or debounced hierarchy job still in flight when the stream dropped.
        layoutInspectorState.updateConnectionStatus(ConnectionStatus.Disconnected)
        layoutInspectorState.invalidateRenderedDeviceIdentity()
        resetControlTapContext()
      }
    }
  }

  // Reset the control gate to an invalidated, not-live state on device change AND whenever Live
  // Layout opens or closes (issue #3347). While the panel is closed the screenshot/hierarchy
  // collectors stop, but the previous frame's device identity + Connected status persist — so
  // reopening for the same device would otherwise enable Control against a mirror frozen for the
  // whole closed period. Keying on isLiveLayoutMode makes reopen start invalidated; fresh
  // screenshot+hierarchy frames (a newer generation) re-arm it, and the generation guard drops the
  // replayed stale frame. resetControlTapContext() also drops any queued tap backlog and clears a
  // stale error banner so nothing from the previous context leaks into the new one. Keyed on the
  // data-source mode and connected process too, so a transport/mode change resets the tap context
  // as
  // well.
  LaunchedEffect(activeDeviceId, isLiveLayoutMode, dataSourceMode, connectedMcpProcess) {
    layoutInspectorState.updateConnectionStatus(ConnectionStatus.Disconnected)
    layoutInspectorState.invalidateRenderedDeviceIdentity()
    resetControlTapContext()
  }

  // Populate telemetry event cache for global search (mirroring TelemetryDashboard's collection)
  LaunchedEffect(telemetryPushClient) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.telemetryEvents.collect { event ->
      telemetryEventCache.add(event)
      // Cap at 500 events
      while (telemetryEventCache.size > 500) {
        telemetryEventCache.removeAt(0)
      }
    }
  }

  // Load installed apps with periodic polling (every 5 seconds) to keep FG state updated
  LaunchedEffect(dataSourceMode, clientProvider, activeDeviceId) {
    if (dataSourceMode == DataSourceMode.Real && clientProvider != null && activeDeviceId != null) {
      // Initial load
      isAppListLoading = true
      var isFirstLoad = true

      while (true) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
          try {
            val appListDataSource =
              graph.dataSourceFactory.createAppListDataSource(
                dataSourceMode,
                clientProvider,
                activeDeviceId,
              )
            when (val result = appListDataSource.getInstalledApps()) {
              is Result.Success -> {
                if (isFirstLoad) {
                  LOG.info("Loaded ${result.data.size} installed apps")
                }
                installedApps = result.data
                // Auto-select foreground app if none selected (only on first load)
                if (isFirstLoad && selectedAppId == null) {
                  selectedAppId = selectDefaultApp(result.data, realDevice?.type)
                  LOG.info("Auto-selected app: $selectedAppId")
                }
              }
              is Result.Error -> {
                if (isFirstLoad) {
                  LOG.warn("Failed to load installed apps: ${result.message}")
                }
              }
              is Result.Loading -> {}
            }
          } catch (e: Exception) {
            if (isFirstLoad) {
              LOG.error("Exception loading installed apps", e)
            }
          } finally {
            if (isFirstLoad) {
              isAppListLoading = false
              isFirstLoad = false
            }
          }
        }
        // Poll every 5 seconds
        kotlinx.coroutines.delay(5000)
      }
    } else if (dataSourceMode == DataSourceMode.Fake) {
      // Load fake apps for development (no polling needed)
      kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val fakeAppListDataSource =
          graph.dataSourceFactory.createAppListDataSource(dataSourceMode, null, null)
        when (val result = fakeAppListDataSource.getInstalledApps()) {
          is Result.Success -> {
            installedApps = result.data
            if (selectedAppId == null) {
              selectedAppId = selectDefaultApp(result.data, null)
            }
          }
          else -> {}
        }
      }
    }
  }

  // Devices list switches based on mode
  val bootedDevices =
    if (dataSourceMode == DataSourceMode.Fake) {
      mockBootedDevices
    } else {
      // In Real mode, show all connected MCP devices
      realDevices
    }

  // Compute platform based on device type for iOS/Android-specific data flow
  val isIOSDevice =
    realDevice?.type == DeviceType.iOSSimulator || realDevice?.type == DeviceType.iOSPhysical
  val platformString = if (isIOSDevice) "ios" else "android"
  // Publish it to the control session, which was created before the device list resolved.
  SideEffect { controlPlatform.value = platformString }
  val storagePlatform = if (isIOSDevice) StoragePlatform.iOS else StoragePlatform.Android

  val availableEmulators = remember {
    listOf(
      AvailableEmulator("pixel6", "Pixel 6 API 33", DeviceType.AndroidEmulator, "33"),
      AvailableEmulator("pixel5", "Pixel 5 API 31", DeviceType.AndroidEmulator, "31"),
      AvailableEmulator("iphone14", "iPhone 14", DeviceType.iOSSimulator),
      AvailableEmulator("ipad", "iPad Pro (12.9-inch)", DeviceType.iOSSimulator),
    )
  }
  val systemImages = remember {
    listOf(
      SystemImage("android-35", "Android 15 (VanillaIceCream)", "Android", "35"),
      SystemImage("android-34", "Android 14 (UpsideDownCake)", "Android", "34"),
      SystemImage("ios-17", "iOS 17.2", "iOS", "17.2"),
      SystemImage("ios-16", "iOS 16.4", "iOS", "16.4"),
    )
  }

  // Test flow replay state
  var testFlowScreens by remember { mutableStateOf<List<String>>(emptyList()) }
  var currentReplayIndex by remember { mutableIntStateOf(0) }
  var isReplaying by remember { mutableStateOf(false) }

  // Toggle between Layout Inspector and Navigation in the main content area
  var showNavigationView by remember { mutableStateOf(false) }
  var isNavigationDetailView by remember { mutableStateOf(false) }

  // Populate command registry now that all state vars are in scope
  val commandRegistry = remember { CommandRegistry() }
  LaunchedEffect(showLeftPane, showRightPane, showBottomPane, showNavigationView) {
    commandRegistry.clear()
    commandRegistry.registerAll(
      buildDefaultCommands(
        onToggleLeftPane = { showLeftPane = !showLeftPane },
        onToggleRightPane = { showRightPane = !showRightPane },
        onToggleBottomPane = { showBottomPane = !showBottomPane },
        onClearTelemetry = { telemetryEventCache.clear() },
        onExportEvents = {
          val jsonArray = buildJsonArray {
            telemetryEventCache.take(1000).forEach { event ->
              add(
                buildJsonObject {
                  put("type", event::class.simpleName ?: "unknown")
                  put("timestamp", event.timestamp)
                }
              )
            }
          }
          SwingFileSaver.save(
            "telemetry_events.json",
            jsonArray.toString(),
            onSuccess = {},
            onError = { LOG.warn("Failed to export telemetry events: ${it.message}") },
          )
        },
        onSwitchToDarkMode = { isDarkMode = true },
        onSwitchToLightMode = { isDarkMode = false },
        onOpenSettings = { showSettings = true },
        onTakeScreenshot = takeScreenshot,
        onToggleLiveLayout = { showNavigationView = !showNavigationView },
      )
    )
  }

  // Search provider wired to telemetry events, navigation screens, and installed apps
  val searchProvider: SearchResultProvider =
    remember(
      telemetryEventCache.size,
      telemetryEventCache.lastOrNull()?.timestamp,
      installedApps.size,
    ) {
      object : SearchResultProvider {
        override fun search(query: String): List<SearchResult> {
          if (query.isBlank()) return emptyList()
          val results = mutableListOf<SearchResult>()
          // Telemetry events (most recent 200, capped for performance)
          telemetryEventCache
            .takeLast(200)
            .filter { it.matchesSearch(query) }
            .take(20)
            .forEachIndexed { i, event ->
              val (label, preview) =
                when (event) {
                  is TelemetryDisplayEvent.Network ->
                    "${event.method} ${event.url}" to "${event.statusCode}"
                  is TelemetryDisplayEvent.Log ->
                    "[${event.tag}] ${event.message.take(40)}" to event.tag
                  is TelemetryDisplayEvent.Navigation -> event.destination to (event.source ?: "")
                  is TelemetryDisplayEvent.Failure -> event.title to event.type
                  else -> (event::class.simpleName ?: "Event") to ""
                }
              results.add(
                SearchResult(
                  id = "tel_${i}_${event.timestamp}",
                  category = SearchCategory.TelemetryEvent,
                  label = label,
                  preview = preview,
                  onSelect = {},
                )
              )
            }
          // Navigation screens from mock data
          NavigationMockData.screens
            .filter {
              it.name.contains(query, ignoreCase = true) ||
                it.packageName.contains(query, ignoreCase = true)
            }
            .take(10)
            .forEach { screen ->
              results.add(
                SearchResult(
                  id = "nav_${screen.id}",
                  category = SearchCategory.NavigationScreen,
                  label = screen.name,
                  preview = "${screen.type} · ${screen.packageName}",
                  onSelect = {},
                )
              )
            }
          // Installed apps as hierarchy elements
          installedApps
            .filter { it.packageName.contains(query, ignoreCase = true) }
            .take(10)
            .forEach { app ->
              results.add(
                SearchResult(
                  id = "app_${app.packageName}",
                  category = SearchCategory.HierarchyElement,
                  label = app.packageName.substringAfterLast('.'),
                  preview = app.packageName,
                  onSelect = { selectedAppId = app.packageName },
                )
              )
            }
          return results
        }
      }
    }

  // Setup state - true when AutoMobile service/daemon not detected or accessibility service not
  // running
  // TODO: Replace with actual service detection
  var needsSetup by remember { mutableStateOf(false) }

  // Animate through the test flow screens
  androidx.compose.runtime.LaunchedEffect(isReplaying, testFlowScreens) {
    if (isReplaying && testFlowScreens.isNotEmpty()) {
      currentReplayIndex = 0
      while (isReplaying && currentReplayIndex < testFlowScreens.size) {
        kotlinx.coroutines.delay(800) // Show each screen for 800ms
        if (currentReplayIndex < testFlowScreens.size - 1) {
          currentReplayIndex++
        } else {
          // Reached end - restart or stop
          kotlinx.coroutines.delay(1000) // Pause at end
          currentReplayIndex = 0 // Loop back
        }
      }
    }
  }

  // Compute the current highlighted screens for replay (show path up to current index)
  val replayHighlightedScreens =
    remember(testFlowScreens, currentReplayIndex, isReplaying) {
      if (isReplaying && testFlowScreens.isNotEmpty()) {
        testFlowScreens.take(currentReplayIndex + 1)
      } else {
        testFlowScreens
      }
    }

  val colors = SharedTheme.globalColors

  // Track header height for padding non-navigation content
  var headerHeight by remember { mutableStateOf(0) }
  val density = LocalDensity.current
  val headerHeightDp = with(density) { headerHeight.toDp() }

  // Min/max widths for vertical panels
  val minPanelWidthPx = with(density) { 225.dp.toPx() } // 150dp * 1.5
  val maxPanelWidthPx = with(density) { 500.dp.toPx() }

  // Settings panel (full-screen overlay)
  if (showSettings) {
    SettingsPanel(
      settings = settingsProvider,
      onClose = { showSettings = false },
      clientProvider = clientProvider,
      modifier = Modifier.fillMaxSize(),
    )
    return
  }

  Box(
    modifier =
      Modifier.fillMaxSize().onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val isModifier = event.isMetaPressed || event.isCtrlPressed
        if (isModifier && event.isShiftPressed) {
          when (event.key) {
            Key.P -> {
              showCommandPalette = true
              true
            }
            Key.F -> {
              showGlobalSearch = true
              true
            }
            else -> false
          }
        } else {
          false
        }
      }
  ) {
    ThreePaneShell(
      showLeftPane = showLeftPane,
      onToggleLeftPane = { showLeftPane = !showLeftPane },
      showRightPane = showRightPane,
      onToggleRightPane = { showRightPane = !showRightPane },
      showBottomPane = showBottomPane,
      onToggleBottomPane = { showBottomPane = !showBottomPane },
      deviceName = realDevice?.name,
      foregroundApp =
        realDevice?.foregroundApp ?: installedApps.find { it.isForeground }?.packageName,
      crashCount = crashCount,
      anrCount = anrCount,
      nonFatalCount = nonFatalCount,
      toolFailureCount = toolFailureCount,
      currentFps = currentFps,
      currentMemoryMb = currentMemoryMb,
      isDaemonConnected = connectedMcpProcess != null,
      onNavigateUp = { if (selectedEventIndex > 0) selectedEventIndex-- },
      onNavigateDown = { selectedEventIndex++ },
      onSelectEvent = {
        // Opens the inspector for the currently focused event
        if (selectedEventIndex >= 0) showRightPane = true
      },
      onDeselectEvent = {
        if (showRightPane) {
          showRightPane = false
        } else {
          selectedEventIndex = -1
        }
      },
      onJumpToTop = { selectedEventIndex = 0 },
      onJumpToBottom = { /* No-op until event list size is known */ },
      onQuickJump = { /* Timestamp jump placeholder */ },
      menuBarActions = menuBarActions,
      vimModeEnabled = vimModeEnabled,
      // The shell's navigation shortcuts run in a PREVIEW handler, so without this they consume
      // Tab / arrows / Enter / Escape before the focused device canvas ever sees them — and Escape
      // is the client's only device-button binding (issue #3351). Evaluated PER EVENT with the same
      // policy the canvas applies: Compose never reruns a preview handler while an unconsumed
      // event bubbles up, so standing down for a keystroke the canvas then declines (a printable
      // key on iOS, a shifted device key) would leave it with neither the device nor the shell.
      deviceControlCapturesKeys = { event ->
        deviceCanvasFocused &&
          deviceControlSession.interactionSnapshot != null &&
          deviceControlSession.wouldForwardKey(DeviceKeyboardEventTranslator.translate(event))
      },
      centerContent = { mod ->
        if (isLiveLayoutMode) {
          // Live layout mode: center shows device screenshot with element overlays.
          //
          // Device control resolves to exactly one atomic snapshot (issue #3348). Every condition
          // #3347 gated inline here — opt-in, Real mode, an explicit selection, an input-capable
          // transport, stream liveness, screenshot AND hierarchy device identity, and geometry —
          // is now a rule inside the Compose-free DeviceControlPolicy, which additionally pairs
          // the screenshot and hierarchy by daemon *provenance* and bounds how old the displayed
          // frame may be. Control is available only when that policy can build a snapshot; the
          // view then maps clicks through that snapshot and hands it back with each tap, so a
          // snapshot swap between click and dispatch cannot change what the daemon receives.
          //
          // Re-evaluated on a slow ticker as well as on source updates, because a stalled
          // observation stream produces no updates at all — its staleness is only visible as time
          // passing.
          controlFreshnessTick
          val deviceControlDecision =
            deviceControlSession.evaluate(
              DeviceControlInputs(
                enabled = enableDeviceControl,
                realDeviceMode = dataSourceMode == DataSourceMode.Real,
                selectedDeviceId = activeDeviceId,
                transportSupportsInput =
                  connectedMcpProcess?.connectionType?.supportsDaemonInput == true,
                observationStreamConnected =
                  layoutInspectorState.connectionStatus == ConnectionStatus.Connected,
                screenshot = layoutInspectorState.screenshotFacts,
                hierarchy = layoutInspectorState.hierarchyFacts,
                // Control maps and renders the paired observation screenshot. WebRTC has no
                // capture identity, so it is only an Inspector-mode rendering source and must not
                // decide whether the independently paired screenshot is actionable.
                liveFrame = null,
              )
            )
          // What a CLICK acts through. While a post-input refresh is pending this is the retained
          // frame rather than the live decision, so the coherent frame on screen stays clickable
          // instead of silently flipping to Inspector between a tap and its successor (#3348).
          val controlSnapshot = deviceControlSession.interactionSnapshot
          // What the inspector RENDERS, which is not always what control may act through: after a
          // successful tap the clicked snapshot is retained until a genuinely superseding one
          // arrives (issue #3348's refresh policy). A screenshot-only update in the meantime does
          // not pair with the retained hierarchy, so it produces no snapshot and must not replace
          // the coherent picture on screen.
          //
          // EVERYTHING the view draws and maps through comes from this one snapshot — pixels,
          // dimensions and tree together. Taking the bytes from newest-independent state while
          // retaining the hierarchy would put new pixels on screen against the clicked snapshot's
          // old tree, which is the half-updated frame this policy exists to prevent. Falls back to
          // live state only before the first snapshot exists.
          val renderSnapshot = deviceControlSession.renderSnapshot
          Box(mod.background(colors.text.normal.copy(alpha = 0.02f))) {
            DeviceScreenView(
              screenshotData =
                renderSnapshot?.screenshotData ?: layoutInspectorState.screenshotData,
              // WebRTC frames have no capture identity. In control mode render the paired
              // observation screenshot instead, so the pixels the user clicks carry the same
              // frameContext as the hierarchy and input request.
              liveFrame = if (controlSnapshot == null) liveVideoFrame?.bitmap else null,
              screenWidth = renderSnapshot?.deviceWidth ?: layoutInspectorState.screenWidth,
              screenHeight = renderSnapshot?.deviceHeight ?: layoutInspectorState.screenHeight,
              rotation = layoutInspectorState.rotation,
              hierarchy = renderSnapshot?.hierarchy?.root ?: layoutInspectorState.hierarchy,
              selectedElementId = layoutInspectorState.selectedElementId,
              hoveredElementId = layoutInspectorState.hoveredElementId,
              onElementSelected = { layoutInspectorState.selectElement(it) },
              onElementHovered = { layoutInspectorState.hoverElement(it) },
              showTapTargetIssues = layoutInspectorState.showTapTargetIssues,
              onToggleTapTargetIssues = { layoutInspectorState.toggleTapTargetIssues() },
              connectionStatus = layoutInspectorState.connectionStatus,
              socketExists = true,
              elementMap =
                (renderSnapshot?.hierarchy?.elementMap ?: layoutInspectorState.currentElementMap)
                  .takeIf { it.isNotEmpty() },
              modifier = Modifier.fillMaxSize(),
              // Device control (issues #3347, #3348): the reference desktop app opts in via
              // enableDeviceControl; the IDE plugin leaves it false and stays inspector-only.
              // Every other condition is decided by DeviceControlPolicy above — control mode is on
              // exactly when it produced a snapshot, and off (inspector) otherwise.
              controlMode =
                if (controlSnapshot != null) DeviceScreenControlMode.Control
                else DeviceScreenControlMode.Inspector,
              // The snapshot the view maps clicks through. Passing it here — rather than letting
              // the view derive bounds from whatever live state it last recomposed with — is what
              // makes an equal-aspect resolution change unable to mis-scale a tap.
              controlSnapshot = controlSnapshot,
              // The view maps a click through `snapshot` and hands both back atomically; the
              // session forwards it to the daemon input/tap helper off the UI thread and never
              // crashes on failure — the daemon's actionable error surfaces in
              // deviceControlTapError instead.
              onControlTap = { snapshot, point -> deviceControlSession.tap(snapshot, point) },
              // A control-mode drag (issue #3350) travels the SAME session — the same bounded
              // ordered queue, the same error claim, the same post-input refresh tracker — so a
              // tap-then-swipe sequence reaches the device in the order the user made it. The
              // threshold and out-of-bounds rules live in the session's pure drag policy, not
              // here.
              onControlSwipe = { snapshot, start, end, durationMs ->
                deviceControlSession.swipe(snapshot, start, end, durationMs)
              },
              // Keyboard, text and device buttons (issue #3351) travel that SAME session too, so a
              // tap-then-type sequence reaches the device in order. The session answers whether it
              // forwarded anything, and the view returns that as its onKeyEvent result — so a chord
              // the policy leaves to the host is not consumed here and still reaches this app's own
              // shortcuts.
              onControlKey = { snapshot, stroke -> deviceControlSession.key(snapshot, stroke) },
              onControlFocusChanged = { focused -> deviceCanvasFocused = focused },
            )

            ScreenshotMetadataOverlay(
              fallback = layoutInspectorState.screenshotFallback,
              fallbackReason = layoutInspectorState.screenshotFallbackReason,
              format = layoutInspectorState.screenshotFormat,
              captureSource = layoutInspectorState.screenshotCaptureSource,
              modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
            )

            // Bottom notices share one Column so they stack instead of overlapping when both are
            // visible (a lingering tap-error banner plus a block that outlasts the debounce).
            Column(
              modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              // Why control is unavailable (issue #4531). The policy's reason is surfaced only
              // when no interaction snapshot exists — while a post-input refresh retains one,
              // clicks still actuate the device, so a "blocked" notice would contradict what the
              // user experiences. The notice itself debounces, so the transient reasons that come
              // and go during normal streaming never flicker into view.
              DeviceControlBlockedNotice(
                reason =
                  if (controlSnapshot == null) {
                    (deviceControlDecision as? DeviceControlDecision.Blocked)?.reason
                  } else {
                    null
                  }
              )

              deviceControlTapError?.let { message ->
                DeviceControlTapErrorBanner(
                  message = message,
                  onDismiss = { deviceControlTapError = null },
                )
              }
            }
          }
        } else {
          Column(mod) {
            // Telemetry is the primary center content
            TelemetryDashboard(
              telemetryPushClient = telemetryPushClient,
              dataSourceMode = dataSourceMode,
              activeDeviceId = activeDeviceId,
              selectedEvent = selectedTelemetryEvent,
              onEventSelected = { event ->
                selectedTelemetryEvent = event
                if (event != null && !showRightPane) showRightPane = true
              },
              timelineState = timelineState,
              onFilterChanged = { categoryKey ->
                filteredTimelineCategories =
                  if (categoryKey != null) {
                    TimelineCategory.entries.filter { it.name != categoryKey }.toSet()
                  } else {
                    emptySet()
                  }
              },
              modifier = Modifier.weight(1f),
            )
            // Bottom tabs for secondary views
            HorizontalTabBar(
              tabs = horizontalTabs,
              selectedTabId = selectedHorizontalTabId,
              onTabSelected = { selectedHorizontalTabId = it },
            )
            if (selectedHorizontalTabId != null) {
              Box(Modifier.fillMaxWidth().weight(0.5f)) {
                when (selectedHorizontalTabId) {
                  "test_runs" ->
                    TestDashboard(
                      onNavigateToGraph = { screens ->
                        testFlowScreens = screens
                        isReplaying = true
                        currentReplayIndex = 0
                        showNavigationView = true
                      },
                      dataSourceMode = dataSourceMode,
                      clientProvider = clientProvider,
                      observationStreamClient = observationStreamClient,
                    )
                  "storage" ->
                    StorageDashboard(
                      dataSourceMode = dataSourceMode,
                      clientProvider = clientProvider,
                      deviceId = activeDeviceId,
                      packageName = selectedAppId,
                      platform = storagePlatform,
                      observationStreamClient = observationStreamClient,
                    )
                  "snapshots" ->
                    SnapshotsDashboard(
                      actions = snapshotActions,
                      configClient = snapshotConfigClient,
                      activeDeviceId = activeDeviceId,
                    )
                  "device_controls" ->
                    DeviceControlsDashboard(
                      appearanceClient = appearanceClient,
                      recordingActions = recordingActions,
                      recordingConfigClient = recordingConfigClient,
                      streamClient = webRtcStreamClient,
                      activeDeviceId = activeDeviceId,
                    )
                  "diagnostics" ->
                    DiagnosticsDashboard(
                      connectedMcpProcess = connectedMcpProcess,
                      dataSourceMode = dataSourceMode,
                    )
                }
              }
            }
          }
        }
      },
      leftPaneContent = {
        // Stub: replaced by real LeftSidebarPanel when Unit 2 merges
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(8.dp)) {
          // Data source mode toggle
          Text("Data Source", color = colors.text.normal, fontSize = 14.sp)
          Spacer(Modifier.height(4.dp))
          Row(verticalAlignment = Alignment.CenterVertically) {
            val realSelected = dataSourceMode == DataSourceMode.Real
            Text(
              text = "Real",
              color = if (realSelected) colors.text.info else colors.text.normal.copy(alpha = 0.5f),
              fontSize = 12.sp,
              modifier =
                Modifier.clickable {
                    dataSourceMode = DataSourceMode.Real
                    activeDeviceId = null
                    isDevicePanelExpanded = true
                  }
                  .padding(end = 8.dp),
            )
            Text(
              text = "Fake",
              color =
                if (!realSelected) colors.text.info else colors.text.normal.copy(alpha = 0.5f),
              fontSize = 12.sp,
              modifier =
                Modifier.clickable {
                    dataSourceMode = DataSourceMode.Fake
                    if (mockBootedDevices.isNotEmpty()) {
                      activeDeviceId = mockBootedDevices.first().id
                      isDevicePanelExpanded = false
                    }
                  }
                  .padding(end = 8.dp),
            )
          }
          Spacer(Modifier.height(12.dp))

          // MCP connection status & controls
          Text("MCP Connection", color = colors.text.normal, fontSize = 14.sp)
          Spacer(Modifier.height(8.dp))
          connectedMcpProcess?.let { process ->
            Text("Connected: ${process.name}", color = colors.text.info, fontSize = 12.sp)
            Text(
              "PID: ${process.pid}",
              color = colors.text.normal.copy(alpha = 0.7f),
              fontSize = 11.sp,
            )
          }
            ?: run {
              Text("Not connected", color = colors.text.warning, fontSize = 12.sp)
              if (dataSourceMode == DataSourceMode.Real) {
                Spacer(Modifier.height(4.dp))
                Text(
                  text = "[Retry Detection]",
                  color = colors.text.info,
                  fontSize = 12.sp,
                  modifier = Modifier.clickable { mcpConnectRetryCounter++ },
                )
              }
            }
          Spacer(Modifier.height(16.dp))
          Text("Booted Devices", color = colors.text.normal, fontSize = 14.sp)
          Spacer(Modifier.height(8.dp))
          val devices =
            if (dataSourceMode == DataSourceMode.Fake) mockBootedDevices else realDevices
          if (devices.isEmpty()) {
            Text(
              "No booted devices",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
            )
          }
          devices.forEach { device ->
            val isActive = device.id == activeDeviceId
            Row(
              verticalAlignment = Alignment.CenterVertically,
              modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            ) {
              Text(
                text =
                  "${if (device.type == DeviceType.iOSSimulator || device.type == DeviceType.iOSPhysical) "\uD83C\uDF4E" else "\uD83E\uDD16"} ${device.name}",
                color = if (isActive) colors.text.info else colors.text.normal,
                fontSize = 12.sp,
                modifier =
                  Modifier.weight(1f).clickable {
                    activeDeviceId = device.id
                    realDevice = device
                    isDevicePanelExpanded = false
                  },
              )
              // Kill button
              Text(
                "\u23F9",
                fontSize = 10.sp,
                color = colors.text.error.copy(alpha = 0.6f),
                modifier =
                  Modifier.clickable {
                      val platform =
                        if (
                          device.type == DeviceType.iOSSimulator ||
                            device.type == DeviceType.iOSPhysical
                        )
                          "ios"
                        else "android"
                      kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
                        try {
                          val client = clientProvider?.invoke()
                          LOG.info(
                            "Killing device ${device.name} (${device.id}) via ${client?.transportName}"
                          )
                          val result = client?.killDevice(device.name, device.id, platform)
                          if (result?.success == false) {
                            LOG.info("Failed to kill device: ${result.message}")
                          }
                        } catch (e: Exception) {
                          LOG.info("Failed to kill device: ${e.message}")
                        }
                      }
                    }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(4.dp),
              )
            }
          }

          // Device images (available to boot) — grouped by platform with filters
          if (deviceImages.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))

            // Persisted filter state — read/write to ~/.automobile/device-filter.json
            val filterFile = remember {
              java.io.File(System.getProperty("user.home"), ".automobile/device-filter.json")
            }
            val savedFilter = remember { loadDeviceFilter(filterFile) }
            var minApiFilter by remember { mutableStateOf(savedFilter.minApi.toFloat()) }
            var maxApiFilter by remember { mutableStateOf(savedFilter.maxApi.toFloat()) }
            var googleApisOnly by remember { mutableStateOf(savedFilter.googleApisOnly) }
            var minIosFilter by remember { mutableStateOf(savedFilter.minIos.toFloat()) }
            var maxIosFilter by remember { mutableStateOf(savedFilter.maxIos.toFloat()) }
            var showIphone by remember { mutableStateOf(savedFilter.showIphone) }
            var showIpad by remember { mutableStateOf(savedFilter.showIpad) }
            var imagesExpanded by remember { mutableStateOf(false) }

            fun saveFilters() {
              saveDeviceFilter(
                filterFile,
                minApiFilter.toInt(),
                maxApiFilter.toInt(),
                googleApisOnly,
                minIosFilter.toInt(),
                maxIosFilter.toInt(),
                showIphone,
                showIpad,
              )
            }

            Row(
              verticalAlignment = Alignment.CenterVertically,
              modifier =
                Modifier.fillMaxWidth()
                  .clickable { imagesExpanded = !imagesExpanded }
                  .pointerHoverIcon(PointerIcon.Hand),
            ) {
              Text(
                if (imagesExpanded) "\u25BE" else "\u25B8",
                fontSize = 10.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
              Spacer(Modifier.width(4.dp))
              Text("Available Devices", color = colors.text.normal, fontSize = 14.sp)
              Spacer(Modifier.weight(1f))
              Text(
                "${deviceImages.size}",
                fontSize = 10.sp,
                color = colors.text.normal.copy(alpha = 0.4f),
              )
            }

            if (imagesExpanded) {
              Spacer(Modifier.height(4.dp))
              val bootedIds = devices.map { it.id }.toSet()
              val androidImages = deviceImages.filter {
                it.platform == "android" && (it.deviceId == null || it.deviceId !in bootedIds)
              }
              val iosImages = deviceImages.filter {
                it.platform == "ios" && (it.deviceId == null || it.deviceId !in bootedIds)
              }
              var showAndroid by remember { mutableStateOf(true) }
              var showIos by remember { mutableStateOf(true) }

              // ── Android group ──
              if (androidImages.isNotEmpty()) {
                Row(
                  verticalAlignment = Alignment.CenterVertically,
                  modifier =
                    Modifier.fillMaxWidth()
                      .clickable { showAndroid = !showAndroid }
                      .pointerHoverIcon(PointerIcon.Hand)
                      .padding(vertical = 2.dp),
                ) {
                  Text(
                    if (showAndroid) "\u25BE" else "\u25B8",
                    fontSize = 10.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                  )
                  Spacer(Modifier.width(4.dp))
                  Text(
                    "\uD83E\uDD16 Android",
                    fontSize = 11.sp,
                    color = colors.text.normal.copy(alpha = 0.7f),
                  )
                  Spacer(Modifier.weight(1f))
                  Text(
                    "${androidImages.size}",
                    fontSize = 9.sp,
                    color = colors.text.normal.copy(alpha = 0.4f),
                  )
                }
                if (showAndroid) {
                  // API range sliders
                  Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp),
                  ) {
                    Text(
                      "API ${minApiFilter.toInt()}-${maxApiFilter.toInt()}",
                      fontSize = 9.sp,
                      color = colors.text.normal.copy(alpha = 0.5f),
                      modifier = Modifier.width(55.dp),
                    )
                    Column(Modifier.weight(1f)) {
                      androidx.compose.material3.Slider(
                        value = minApiFilter,
                        onValueChange = { minApiFilter = it.coerceAtMost(maxApiFilter) },
                        onValueChangeFinished = { saveFilters() },
                        valueRange = 21f..35f,
                        steps = 13,
                        modifier = Modifier.fillMaxWidth().height(16.dp),
                      )
                      androidx.compose.material3.Slider(
                        value = maxApiFilter,
                        onValueChange = { maxApiFilter = it.coerceAtLeast(minApiFilter) },
                        onValueChangeFinished = { saveFilters() },
                        valueRange = 21f..35f,
                        steps = 13,
                        modifier = Modifier.fillMaxWidth().height(16.dp),
                      )
                    }
                  }
                  // Google APIs chip
                  Row(modifier = Modifier.padding(start = 12.dp)) {
                    FilterChip("Google APIs", googleApisOnly) {
                      googleApisOnly = !googleApisOnly
                      saveFilters()
                    }
                  }
                  Spacer(Modifier.height(2.dp))
                  // Filtered list
                  val filteredAndroid =
                    androidImages
                      .filter { image ->
                        val apiLevel =
                          extractApiLevel(image.target)
                            ?: Regex("""(?i)api[_-]?(\d+)""")
                              .find(image.name)
                              ?.groupValues
                              ?.get(1)
                              ?.toIntOrNull()
                        val hasGoogleApis =
                          image.target?.contains("google", ignoreCase = true) == true ||
                            image.name.contains("-ga-", ignoreCase = true) ||
                            image.name.contains("Google", ignoreCase = true)
                        if (googleApisOnly && !hasGoogleApis) return@filter false
                        if (apiLevel != null) apiLevel in minApiFilter.toInt()..maxApiFilter.toInt()
                        else true
                      }
                      .sortedBy { it.name }
                  filteredAndroid.forEach { image ->
                    Row(
                      verticalAlignment = Alignment.CenterVertically,
                      modifier =
                        Modifier.fillMaxWidth().padding(start = 12.dp, top = 1.dp, bottom = 1.dp),
                    ) {
                      Text(
                        image.name,
                        color = colors.text.normal.copy(alpha = 0.6f),
                        fontSize = 10.sp,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                      )
                      Text(
                        "\u25B6",
                        fontSize = 9.sp,
                        color = Color(0xFF4CAF50).copy(alpha = 0.7f),
                        modifier =
                          Modifier.clickable {
                              kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
                                try {
                                  clientProvider
                                    ?.invoke()
                                    ?.startDevice(
                                      image.name,
                                      image.platform,
                                      image.deviceId,
                                    )
                                } catch (e: Exception) {
                                  LOG.warn("Failed to start device ${image.name}: ${e.message}")
                                }
                              }
                            }
                            .pointerHoverIcon(PointerIcon.Hand)
                            .padding(4.dp),
                      )
                    }
                  }
                  if (filteredAndroid.isEmpty())
                    Text(
                      "No matching images",
                      fontSize = 10.sp,
                      color = colors.text.normal.copy(alpha = 0.4f),
                      modifier = Modifier.padding(start = 12.dp),
                    )
                }
              }

              // ── iOS group ──
              if (iosImages.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Row(
                  verticalAlignment = Alignment.CenterVertically,
                  modifier =
                    Modifier.fillMaxWidth()
                      .clickable { showIos = !showIos }
                      .pointerHoverIcon(PointerIcon.Hand)
                      .padding(vertical = 2.dp),
                ) {
                  Text(
                    if (showIos) "\u25BE" else "\u25B8",
                    fontSize = 10.sp,
                    color = colors.text.normal.copy(alpha = 0.5f),
                  )
                  Spacer(Modifier.width(4.dp))
                  Text(
                    "\uD83C\uDF4E iOS",
                    fontSize = 11.sp,
                    color = colors.text.normal.copy(alpha = 0.7f),
                  )
                  Spacer(Modifier.weight(1f))
                  Text(
                    "${iosImages.size}",
                    fontSize = 9.sp,
                    color = colors.text.normal.copy(alpha = 0.4f),
                  )
                }
                if (showIos) {
                  // Collect all available versions sorted, for slider steps
                  val allVersions =
                    remember(iosImages) {
                      iosImages
                        .mapNotNull { it.iosVersion }
                        .distinct()
                        .sortedWith(
                          compareBy(
                            { it.substringBefore('.').toIntOrNull() ?: 0 },
                            { it.substringAfter('.', "0").toIntOrNull() ?: 0 },
                          )
                        )
                    }
                  // Version slider — only shown when 2+ distinct versions exist
                  var minIdx by remember { mutableStateOf(0f) }
                  var maxIdxState by remember {
                    mutableStateOf((allVersions.size - 1).coerceAtLeast(0).toFloat())
                  }
                  if (allVersions.size >= 2) {
                    val maxIdx = (allVersions.size - 1).toFloat()
                    // Clamp state in case allVersions changed
                    val clampedMaxIdx = maxIdxState.coerceIn(0f, maxIdx)
                    val clampedMinIdx = minIdx.coerceIn(0f, clampedMaxIdx)
                    val minVer =
                      allVersions.getOrElse(clampedMinIdx.toInt()) { allVersions.first() }
                    val maxVer =
                      allVersions.getOrElse(
                        clampedMaxIdx.toInt().coerceAtMost(allVersions.size - 1)
                      ) {
                        allVersions.last()
                      }

                    Row(
                      verticalAlignment = Alignment.CenterVertically,
                      modifier = Modifier.fillMaxWidth().padding(start = 12.dp),
                    ) {
                      Text(
                        "$minVer\u2013$maxVer",
                        fontSize = 9.sp,
                        color = colors.text.normal.copy(alpha = 0.5f),
                        modifier = Modifier.width(65.dp),
                      )
                      Column(Modifier.weight(1f)) {
                        androidx.compose.material3.Slider(
                          value = clampedMinIdx,
                          onValueChange = { minIdx = it.coerceAtMost(maxIdxState) },
                          onValueChangeFinished = { saveFilters() },
                          valueRange = 0f..maxIdx,
                          steps = (allVersions.size - 2).coerceAtLeast(0),
                          modifier = Modifier.fillMaxWidth().height(16.dp),
                        )
                        androidx.compose.material3.Slider(
                          value = clampedMaxIdx,
                          onValueChange = { maxIdxState = it.coerceAtLeast(minIdx) },
                          onValueChangeFinished = { saveFilters() },
                          valueRange = 0f..maxIdx,
                          steps = (allVersions.size - 2).coerceAtLeast(0),
                          modifier = Modifier.fillMaxWidth().height(16.dp),
                        )
                      }
                    }
                  }

                  // iPhone / iPad chips
                  Row(
                    modifier = Modifier.padding(start = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                  ) {
                    FilterChip("iPhone", showIphone) {
                      showIphone = !showIphone
                      saveFilters()
                    }
                    FilterChip("iPad", showIpad) {
                      showIpad = !showIpad
                      saveFilters()
                    }
                  }
                  Spacer(Modifier.height(2.dp))

                  // Determine selected version range
                  val selectedVersions =
                    if (allVersions.size >= 2) {
                      allVersions
                        .subList(
                          minIdx.toInt().coerceIn(0, allVersions.size - 1),
                          (maxIdxState.toInt() + 1).coerceAtMost(allVersions.size),
                        )
                        .toSet()
                    } else {
                      allVersions.toSet()
                    }

                  // Filter by version range + device type
                  val filteredIos =
                    iosImages
                      .filter { image ->
                        val ver = image.iosVersion
                        val inRange = ver == null || ver in selectedVersions
                        val isIphone = image.name.contains("iPhone", ignoreCase = true)
                        val isIpad = image.name.contains("iPad", ignoreCase = true)
                        val typeOk =
                          when {
                            isIphone -> showIphone
                            isIpad -> showIpad
                            else -> true // Apple Watch, Apple TV, etc.
                          }
                        inRange && typeOk
                      }
                      .sortedBy { it.name }

                  // Group by version, sorted descending
                  val iosByVersion =
                    filteredIos
                      .groupBy { it.iosVersion ?: "Unknown" }
                      .toSortedMap(compareByDescending { it })
                  iosByVersion.forEach { (version, images) ->
                    Text(
                      "iOS $version",
                      fontSize = 9.sp,
                      color = colors.text.normal.copy(alpha = 0.5f),
                      modifier = Modifier.padding(start = 12.dp, top = 4.dp),
                    )
                    images.forEach { image ->
                      Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier =
                          Modifier.fillMaxWidth().padding(start = 16.dp, top = 1.dp, bottom = 1.dp),
                      ) {
                        Text(
                          image.name,
                          color = colors.text.normal.copy(alpha = 0.6f),
                          fontSize = 10.sp,
                          modifier = Modifier.weight(1f),
                          maxLines = 1,
                          overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                        Text(
                          "\u25B6",
                          fontSize = 9.sp,
                          color = Color(0xFF4CAF50).copy(alpha = 0.7f),
                          modifier =
                            Modifier.clickable {
                                kotlinx.coroutines.GlobalScope.launch(Dispatchers.IO) {
                                  try {
                                    clientProvider
                                      ?.invoke()
                                      ?.startDevice(
                                        image.name,
                                        image.platform,
                                        image.deviceId,
                                      )
                                  } catch (e: Exception) {
                                    LOG.warn("Failed to start device ${image.name}: ${e.message}")
                                  }
                                }
                              }
                              .pointerHoverIcon(PointerIcon.Hand)
                              .padding(4.dp),
                        )
                      }
                    }
                  }
                  if (filteredIos.isEmpty())
                    Text(
                      "No matching simulators",
                      fontSize = 10.sp,
                      color = colors.text.normal.copy(alpha = 0.4f),
                      modifier = Modifier.padding(start = 12.dp),
                    )
                }
              }
            }
          }

          // App filter dropdown
          if (installedApps.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text(
              "App Filter",
              color = colors.text.normal,
              fontSize = 12.sp,
              fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
            )
            Spacer(Modifier.height(4.dp))
            var appDropdownExpanded by remember { mutableStateOf(false) }
            Box {
              Text(
                text = selectedAppId?.substringAfterLast('.') ?: "All apps",
                color =
                  if (selectedAppId != null) colors.text.info
                  else colors.text.normal.copy(alpha = 0.6f),
                fontSize = 11.sp,
                modifier =
                  Modifier.fillMaxWidth()
                    .background(
                      colors.text.normal.copy(alpha = 0.05f),
                      RoundedCornerShape(4.dp),
                    )
                    .clickable { appDropdownExpanded = true }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
              )
              androidx.compose.material3.DropdownMenu(
                expanded = appDropdownExpanded,
                onDismissRequest = { appDropdownExpanded = false },
              ) {
                androidx.compose.material3.DropdownMenuItem(
                  text = { Text("All apps", fontSize = 11.sp) },
                  onClick = {
                    selectedAppId = null
                    appDropdownExpanded = false
                  },
                )
                installedApps.forEach { app ->
                  androidx.compose.material3.DropdownMenuItem(
                    text = {
                      Text(
                        app.packageName.substringAfterLast('.'),
                        fontSize = 11.sp,
                        color =
                          if (app.packageName == selectedAppId) colors.text.info
                          else colors.text.normal,
                      )
                    },
                    onClick = {
                      selectedAppId = app.packageName
                      appDropdownExpanded = false
                    },
                  )
                }
              }
            }
          }
          Spacer(Modifier.height(16.dp))
          Text(
            text = "\u2699 Settings",
            color = colors.text.normal,
            fontSize = 12.sp,
            modifier = Modifier.clickable { showSettings = true }.padding(vertical = 4.dp),
          )
        }
      },
      rightPaneContent = {
        RightInspectorPanel(
          selectedEvent = selectedTelemetryEvent,
          onClose = {
            if (isLiveLayoutMode) isLiveLayoutMode = false else selectedTelemetryEvent = null
          },
          isLiveMode = isLiveLayoutMode,
          onToggleLiveMode = { live ->
            isLiveLayoutMode = live
            if (live && !showRightPane) showRightPane = true
          },
          layoutInspectorState = layoutInspectorState,
          hasDevice = observationStreamClient != null,
          onOpenSource = onOpenSource,
          screenshotLoader =
            remember(clientProvider, dataSourceMode) {
              if (dataSourceMode == DataSourceMode.Real && clientProvider != null)
                NavigationScreenshotLoader(clientProvider)
              else null
            },
        )
      },
      bottomPaneContent = {
        val spans =
          remember(
            telemetryEventCache.size,
            telemetryEventCache.lastOrNull()?.timestamp,
            filteredTimelineCategories,
          ) {
            buildTimelineSpans(telemetryEventCache.toList(), filteredTimelineCategories)
          }
        val lanes = remember(spans) { activeLanes(spans) }
        if (spans.isEmpty()) {
          Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
              "Event Timeline",
              color = colors.text.normal.copy(alpha = 0.5f),
              fontSize = 12.sp,
            )
          }
        } else {
          TimelineCanvas(
            spans = spans,
            activeLanes = lanes,
            state = timelineState,
            onEventClicked = { event ->
              selectedTelemetryEvent = event
              if (!showRightPane) showRightPane = true
            },
            modifier = Modifier.fillMaxSize(),
          )
        }
      },
    )

    // Command palette overlay
    if (showCommandPalette) {
      CommandPalette(
        registry = commandRegistry,
        onDismiss = { showCommandPalette = false },
      )
    }

    // Global search overlay
    if (showGlobalSearch) {
      GlobalSearchOverlay(
        searchProvider = searchProvider,
        onDismiss = { showGlobalSearch = false },
      )
    }
  } // Box
} // AutoMobileContent

@Composable
private fun MainContentViewToggle(
  showNavigation: Boolean,
  onToggle: (Boolean) -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val bgColor = colors.panelBackground.copy(alpha = 0.85f)
  val selectedBg = colors.text.normal.copy(alpha = 0.1f)
  val borderColor = colors.text.normal.copy(alpha = 0.15f)

  Row(
    modifier =
      modifier
        .clip(RoundedCornerShape(6.dp))
        .background(bgColor)
        .border(1.dp, borderColor, RoundedCornerShape(6.dp))
        .padding(2.dp),
    horizontalArrangement = Arrangement.spacedBy(0.dp),
  ) {
    val options = listOf(false to "\uD83D\uDCD0 Layout", true to "\uD83E\uDDED Navigation")
    options.forEach { (isNav, label) ->
      val isSelected = showNavigation == isNav
      Box(
        modifier =
          Modifier.clip(RoundedCornerShape(4.dp))
            .then(if (isSelected) Modifier.background(selectedBg) else Modifier)
            .clickable { onToggle(isNav) }
            .padding(horizontal = 8.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = label,
          fontSize = 11.sp,
          color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
        )
      }
    }
  }
}

@Composable
private fun GlobalShellHeader(
  devices: List<BootedDevice>,
  activeDeviceId: String?,
  onDeviceSelected: (String) -> Unit,
  isDevicePanelExpanded: Boolean = false,
  availableEmulators: List<AvailableEmulator> = emptyList(),
  systemImages: List<SystemImage> = emptyList(),
  onBootEmulator: (String) -> Unit = {},
  onCreateEmulator: (String) -> Unit = {},
  onCollapsePanel: () -> Unit = {},
  needsSetup: Boolean = false,
  onSetupClick: () -> Unit = {},
  dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  onDataSourceModeChanged: (DataSourceMode) -> Unit = {},
  onMcpDeviceSelected: (deviceId: String, deviceName: String?) -> Unit = { _, _ -> },
  onProcessConnected: (McpProcess?) -> Unit = {},
  suppressAutoSelect: Boolean = false,
  // App selector props (kept for backwards compatibility, but FG toggle is preferred)
  installedApps: List<InstalledApp> = emptyList(),
  selectedAppId: String? = null,
  isAppListLoading: Boolean = false,
  appDropdownExpanded: Boolean = false,
  onAppDropdownExpandedChange: (Boolean) -> Unit = {},
  onAppSelected: (String?) -> Unit = {},
  onSettingsClicked: () -> Unit = {},
) {
  val colors = SharedTheme.globalColors

  Column(modifier = Modifier.fillMaxWidth().background(SharedTheme.globalColors.panelBackground)) {
    FlowRow(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      // Left side: Device selection
      if (dataSourceMode == DataSourceMode.Fake) {
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            "Devices:",
            fontSize = 11.sp,
            maxLines = 1,
            softWrap = false,
            color = colors.text.normal.copy(alpha = 0.5f),
          )

          // Device icons
          Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            devices.forEach { device ->
              DeviceIcon(
                device = device,
                isActive = device.id == activeDeviceId,
                onClick = { onDeviceSelected(device.id) },
              )
            }
          }
        }
      } else {
        // Real mode: show MCP server indicator or empty space
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Show "Devices:" when a device is selected, "MCP Servers" otherwise
          if (activeDeviceId != null) {
            Text(
              "Devices:",
              fontSize = 11.sp,
              maxLines = 1,
              softWrap = false,
              color = Color(0xFF2196F3),
              modifier =
                Modifier.clickable {
                    // Clicking "Devices:" expands the device panel
                    // We need to deselect the device and expand the panel
                    onDeviceSelected("")
                  }
                  .pointerHoverIcon(PointerIcon.Hand),
            )

            // Show device buttons next to "Devices:" using emojis with tooltips
            devices.forEach { device ->
              val isActive = device.id == activeDeviceId
              val deviceIsIos =
                device.type == DeviceType.iOSSimulator || device.type == DeviceType.iOSPhysical
              Tooltip(
                tooltip = {
                  Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(device.name, fontSize = 12.sp)
                    Text(
                      "Status: ${device.status}",
                      fontSize = 10.sp,
                      color = colors.text.normal.copy(alpha = 0.6f),
                    )
                    device.foregroundApp?.let { app ->
                      Text(
                        "App: $app",
                        fontSize = 10.sp,
                        color = colors.text.normal.copy(alpha = 0.6f),
                      )
                    }
                  }
                }
              ) {
                Box(
                  modifier =
                    Modifier.background(
                        if (isActive) Color(0xFF2196F3).copy(alpha = 0.15f)
                        else colors.text.normal.copy(alpha = 0.08f),
                        RoundedCornerShape(4.dp),
                      )
                      .clickable {
                        if (device.id == activeDeviceId) {
                          // Tapping active device expands panel to show more devices
                          onDeviceSelected("")
                        } else {
                          onDeviceSelected(device.id)
                        }
                      }
                      .pointerHoverIcon(PointerIcon.Hand)
                      .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                  Icon(
                    imageVector = PlatformIcons.logo(deviceIsIos),
                    contentDescription = PlatformIcons.contentDescription(deviceIsIos),
                    tint = PlatformIcons.tint(deviceIsIos),
                    modifier = Modifier.size(16.dp),
                  )
                }
              }
            }
          } else {
            Text(
              "🔌",
              fontSize = 14.sp,
            )
            Text(
              "MCP Servers",
              fontSize = 11.sp,
              maxLines = 1,
              softWrap = false,
              color = colors.text.normal.copy(alpha = 0.7f),
            )
          }
        }
      }

      // Right side: Setup button (conditional), Real Data toggle, Live toggle
      Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        // Setup AutoMobile button (shown when service not detected)
        if (needsSetup) {
          Box(
            modifier =
              Modifier.background(
                  Color(0xFF2196F3).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
                .clickable(onClick = onSetupClick)
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 8.dp, vertical = 4.dp)
          ) {
            Text(
              "Setup",
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = Color(0xFF64B5F6),
            )
          }
        }

        // Real Data switch
        RealDataSwitch(
          isRealData = dataSourceMode == DataSourceMode.Real,
          onToggle = { isReal ->
            onDataSourceModeChanged(if (isReal) DataSourceMode.Real else DataSourceMode.Fake)
          },
        )

        // Settings gear
        Text(
          "⚙",
          fontSize = 16.sp,
          modifier =
            Modifier.clickable { onSettingsClicked() }
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 8.dp, vertical = 4.dp),
        )
      }
    }

    // Device management panel (expanded when no active device selected)
    if (isDevicePanelExpanded) {
      if (dataSourceMode == DataSourceMode.Real) {
        McpProcessesPanel(
          useRealData = true,
          onDeviceSelected = onMcpDeviceSelected,
          onProcessConnected = onProcessConnected,
          suppressAutoSelect = suppressAutoSelect,
        )
      } else {
        McpProcessesPanel(
          useRealData = false,
          onDeviceSelected = onMcpDeviceSelected,
          onProcessConnected = onProcessConnected,
          suppressAutoSelect = suppressAutoSelect,
        )
      }
    }
  }
}

@Composable
private fun RealDataSwitch(
  isRealData: Boolean,
  onToggle: (Boolean) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val trackColor = if (isRealData) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.3f)
  val thumbColor = Color.White

  Row(
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "Real Data",
      fontSize = 11.sp,
      maxLines = 1,
      softWrap = false,
      color = if (isRealData) colors.text.normal else colors.text.normal.copy(alpha = 0.5f),
    )
    Box(
      modifier =
        Modifier.width(32.dp)
          .height(18.dp)
          .clip(RoundedCornerShape(9.dp))
          .background(trackColor)
          .clickable { onToggle(!isRealData) }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(2.dp)
    ) {
      Box(
        modifier =
          Modifier.size(14.dp)
            .offset(x = if (isRealData) 14.dp else 0.dp)
            .clip(CircleShape)
            .background(thumbColor)
      )
    }
  }
}

@Composable
private fun DraggableTabs(
  tabs: List<Dashboard>,
  selectedIndex: Int,
  onTabSelected: (Int) -> Unit,
  onReorder: (fromIndex: Int, toIndex: Int) -> Unit,
  draggedIndex: Int?,
  onDragStart: (Int) -> Unit,
  onDragEnd: () -> Unit,
  dropTargetIndex: Int?,
  onDropTargetChanged: (Int?) -> Unit,
) {
  LOG.debug("DraggableTabs rendered with ${tabs.size} tabs, selectedIndex=$selectedIndex")
  val colors = SharedTheme.globalColors
  var tabPositions by remember { mutableStateOf<Map<Int, Float>>(emptyMap()) }
  var dragOffset by remember { mutableStateOf(0f) }

  BoxWithConstraints(
    modifier = Modifier.fillMaxWidth().background(SharedTheme.globalColors.panelBackground)
  ) {
    // Three modes: icons only (< 300dp), icon + text (300-600dp), text only (> 600dp)
    val useIconsOnly = maxWidth < 300.dp
    val useIconsWithText = maxWidth >= 300.dp && maxWidth < 600.dp

    Row(
      modifier = Modifier.padding(horizontal = 4.dp),
      horizontalArrangement = Arrangement.Start,
    ) {
      tabs.forEachIndexed { index, dashboard ->
        val isSelected = index == selectedIndex
        val isDragged = index == draggedIndex
        val isDropTarget = index == dropTargetIndex && draggedIndex != null && draggedIndex != index

        Box(
          modifier =
            Modifier.padding(vertical = 4.dp, horizontal = 2.dp)
              .then(if (isDragged) Modifier.offset(x = dragOffset.dp) else Modifier)
              .background(
                when {
                  isDropTarget -> colors.text.normal.copy(alpha = 0.15f)
                  isSelected -> colors.text.normal.copy(alpha = 0.1f)
                  else -> Color.Transparent
                },
                RoundedCornerShape(6.dp),
              )
              .then(
                if (isDropTarget)
                  Modifier.border(
                    1.5.dp,
                    Color(0xFF2196F3).copy(alpha = 0.5f),
                    RoundedCornerShape(6.dp),
                  )
                else Modifier
              )
              .clickable {
                LOG.debug("Tab clicked via clickable: $index (${tabs[index]})")
                onTabSelected(index)
              }
              .pointerInput("drag-$index") {
                detectDragGesturesAfterLongPress(
                  onDragStart = { onDragStart(index) },
                  onDragEnd = {
                    if (
                      draggedIndex != null &&
                        dropTargetIndex != null &&
                        draggedIndex != dropTargetIndex
                    ) {
                      onReorder(draggedIndex, dropTargetIndex)
                    }
                    dragOffset = 0f
                    onDragEnd()
                  },
                  onDragCancel = {
                    dragOffset = 0f
                    onDragEnd()
                  },
                  onDrag = { change, dragAmount ->
                    change.consume()
                    dragOffset += dragAmount.x / 2 // Scale down for smoother feel

                    // Calculate which tab we're over based on position
                    val positions = tabPositions.toList().sortedBy { it.second }
                    val draggedPos = (tabPositions[index] ?: 0f) + dragOffset
                    var newTarget: Int? = null
                    for (i in positions.indices) {
                      val (tabIdx, pos) = positions[i]
                      val nextPos = positions.getOrNull(i + 1)?.second ?: (pos + 80f)
                      if (draggedPos >= pos && draggedPos < nextPos) {
                        newTarget = tabIdx
                        break
                      }
                    }
                    if (newTarget != null && newTarget != draggedIndex) {
                      onDropTargetChanged(newTarget)
                    } else if (newTarget == draggedIndex) {
                      onDropTargetChanged(null)
                    }
                  },
                )
              }
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = if (useIconsOnly) 8.dp else 10.dp, vertical = 6.dp)
              .onGloballyPositioned { coordinates ->
                tabPositions = tabPositions + (index to coordinates.positionInParent().x)
              },
          contentAlignment = Alignment.Center,
        ) {
          val textColor =
            when {
              isDragged -> colors.text.normal.copy(alpha = 0.8f)
              isSelected -> colors.text.normal
              else -> colors.text.normal.copy(alpha = 0.6f)
            }

          when {
            useIconsOnly -> {
              Tooltip(tooltip = { Text(dashboard.title, fontSize = 11.sp) }) {
                Text(dashboard.icon, fontSize = 14.sp)
              }
            }
            useIconsWithText -> {
              Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Text(dashboard.icon, fontSize = 12.sp)
                Text(
                  dashboard.title,
                  fontSize = 11.sp,
                  maxLines = 1,
                  softWrap = false,
                  color = textColor,
                )
              }
            }
            else -> {
              Text(
                dashboard.title,
                fontSize = 12.sp,
                maxLines = 1,
                softWrap = false,
                color = textColor,
              )
            }
          }
        }
      }
    }
  }
}
