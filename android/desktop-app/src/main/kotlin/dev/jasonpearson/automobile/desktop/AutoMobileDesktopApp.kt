package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.FloatingUpdateAffordance
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.shell.UpdateDetailsContent
import dev.jasonpearson.automobile.desktop.core.shell.openReleaseNotesInBrowser
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import dev.jasonpearson.automobile.desktop.core.workspace.BOOTED_DEVICES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.CommandPalette
import dev.jasonpearson.automobile.desktop.core.workspace.DEVICE_LOCK_STATES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.DaemonEmulatorControlExecutor
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceStreamView
import dev.jasonpearson.automobile.desktop.core.workspace.FailuresFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LayoutFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LogsFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NetworkFacet
import dev.jasonpearson.automobile.desktop.core.workspace.OnboardingScreen
import dev.jasonpearson.automobile.desktop.core.workspace.PerformanceFacet
import dev.jasonpearson.automobile.desktop.core.workspace.StorageFacet
import dev.jasonpearson.automobile.desktop.core.workspace.TestFacet
import dev.jasonpearson.automobile.desktop.core.workspace.Tool
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceEffect
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShell
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.buildWorkspaceCommands
import dev.jasonpearson.automobile.desktop.core.workspace.deriveWorkspaceStatus
import dev.jasonpearson.automobile.desktop.core.workspace.isolatedBehindOverlay
import dev.jasonpearson.automobile.desktop.core.workspace.parseBootedDeviceSessionUuids
import dev.jasonpearson.automobile.desktop.core.workspace.parseBootedLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.parseDeviceLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePicker
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerAction
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerEffect
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerUiState
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.RealDeviceBootController
import dev.jasonpearson.automobile.desktop.core.workspace.rememberWorkspaceDeviceControl
import dev.jasonpearson.automobile.desktop.core.workspace.wireName
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("AutoMobileDesktopApp")

// How often the workspace refreshes its daemon session so the idle watchdog does not reap it.
// Matches AutoMobileContent's binding heartbeat cadence.
private const val DESKTOP_SESSION_HEARTBEAT_MS = 2_000L

// How often each observed pane's lock state is re-read so the contextual Unlock control appears or
// disappears as the device locks/unlocks. Runs only while at least one device is observed. NOTE:
// it re-reads the whole booted-devices resource, which recomputes service status AND the keyguard
// probe for every booted device — not a free read. A lighter dedicated lock-state feed is a
// follow-up (see #4694); until then this cadence trades adb load for Unlock responsiveness.
private const val LOCK_STATE_POLL_MS = 4_000L

// How often the device grid re-reads the device list while it is the visible surface, so devices
// started/killed by another client appear without a manual refresh. Matches AutoMobileContent's
// booted-devices poll cadence.
private const val GRID_REFRESH_POLL_MS = 5_000L

/**
 * Wraps a [SettingsProvider] so that [themeMode] is backed by Compose snapshot state, enabling
 * recomposition when the user changes the theme in settings.
 */
private class ObservableSettingsProvider(private val delegate: SettingsProvider) :
  SettingsProvider by delegate {
  private var _themeMode by mutableStateOf(delegate.themeMode)
  override var themeMode: String
    get() = _themeMode
    set(value) {
      _themeMode = value
      delegate.themeMode = value
    }
}

@Composable
fun AutoMobileDesktopApp(
  @Suppress("UNUSED_PARAMETER") menuBarActions: MenuBarActions = remember { MenuBarActions() },
  openPaletteRequest: Int = 0,
  // Hoisted from the single app-level DaemonConnectionMonitor in Main.kt so the status dot and the
  // system-tray icon share one daemon-health source instead of each running its own 5s poll
  // (#4858).
  daemonConnectionState: ConnectionState = ConnectionState.Connecting,
) {
  val graph = LocalAutoMobileGraph.current

  // Update availability (#5225): collect the controller and run one check at app startup — hoisted
  // above the surface switch so it runs regardless of the launch surface (onboarding, picker, or
  // workspace), not only after a device is observed. Keyed to the controller so a graph change
  // re-checks exactly once, rather than on every workspace re-entry. Dev / -SNAPSHOT builds no-op
  // it.
  val updateController = graph.updateController
  val updateStatus by updateController.status.collectAsState()
  var showUpdateDetails by remember { mutableStateOf(false) }
  LaunchedEffect(updateController) { updateController.checkForUpdate() }

  val settings = remember(graph) { ObservableSettingsProvider(graph.settingsProvider) }
  val scope = rememberCoroutineScope()
  val controlExecutor = remember(graph) { DaemonEmulatorControlExecutor(graph.autoMobileClient) }
  val workspaceViewModel =
    remember(scope, controlExecutor) { WorkspaceViewModel(scope, controlExecutor) }
  val workspaceState by workspaceViewModel.state.collectAsState()

  val resourceClient = remember(graph) { DaemonMcpResourceClient(graph.autoMobileClient) }
  val bootController = remember(graph) { RealDeviceBootController(graph.autoMobileClient) }
  val pickerViewModel =
    remember(scope, resourceClient, bootController) {
      DevicePickerViewModel(resourceClient, bootController, scope)
    }
  val pickerState by pickerViewModel.state.collectAsState()
  var pickerOpen by remember { mutableStateOf(false) }

  // Observable daemon-bootstrap progress for the launch surfaces. The startup lifecycle pass —
  // detect the current AutoMobile daemon, or install Bun + start the pinned package when none is
  // reachable — is triggered exactly ONCE, by the picker view model's init load through the daemon
  // client's request preflight; the bootstrap shares that client's lifecycle (see
  // ApplicationModule), so its phases land here regardless of the trigger. Deliberately NO second
  // explicit ensureReady() pass at startup: the lifecycle lock would only serialize it behind the
  // picker's, and after a FAILED first pass (offline Bun install, dead npm fetch) the queued
  // duplicate would repeat the whole failed pipeline for a second full startup timeout before the
  // user ever sees a stable Retry.
  val daemonBootstrap = graph.daemonBootstrap
  val bootstrapState by daemonBootstrap.state.collectAsState()
  var paletteOpen by remember { mutableStateOf(false) }
  var showOnboarding by remember { mutableStateOf(!settings.hasSeenOnboarding) }

  // One stable daemon session per app run, used to authenticate the stream sockets (#4751/#4977).
  // The stream socket's getSession check is read-only, so the session must first be REGISTERED by
  // a main-socket tool call — done below by binding the focused device with setActiveDevice.
  // Unix-daemon only; other transports leave it null and the panes fall back to the auth escape
  // hatch. `getOrNull` so a construction failure (no reachable daemon) degrades to a null provider.
  val desktopDaemonSession =
    remember(graph) {
      if (graph.autoMobileClient.transportName == "Unix Socket") {
        runCatching { DesktopDaemonSession.create() }
          .onFailure { LOG.warn("Could not create a desktop daemon session: ${it.message}") }
          .getOrNull()
      } else {
        null
      }
    }
  // Per-tap client factory for workspace device control. The DeviceControlSession closes the client
  // it mints per action, so this MUST return a fresh McpDaemonClient each call, never the shared
  // graph.autoMobileClient. Non-Unix transports don't support device input, so they yield null and
  // the pane stays a display-only mirror.
  val workspaceControlClientProvider: () -> AutoMobileClient? =
    remember(graph) {
      if (graph.autoMobileClient.transportName == "Unix Socket") {
        { McpDaemonClient(DaemonSocketPaths.socketPath()) }
      } else {
        { null }
      }
    }
  val sessionCleanupScope =
    remember(desktopDaemonSession) {
      desktopDaemonSession?.let { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    }
  DisposableEffect(desktopDaemonSession, sessionCleanupScope) {
    onDispose {
      if (desktopDaemonSession != null && sessionCleanupScope != null) {
        sessionCleanupScope.launch {
          runCatching { desktopDaemonSession.release() }
            .onFailure { LOG.warn("Failed to release desktop daemon session: ${it.message}") }
          sessionCleanupScope.cancel()
        }
      }
    }
  }

  // Register + bind the session to the FOCUSED device, then heartbeat it, then RE-register whenever
  // the heartbeat detects the session died — which is exactly what a daemon restart looks like: the
  // registry is wiped, so the stream sockets reject the (now-unknown) session until it is
  // recreated.
  // One loop owns the whole lifecycle so a restart self-heals: re-register (setActiveDevice lazily
  // recreates the session under the same stable UUID) → the panes' auto-reconnect then
  // re-subscribes
  // successfully. Stream auth admits every pane: the focused device is owned by this session; each
  // other observed device is unowned, so its subscribe passes the unowned-device branch.
  val focusedColumn =
    (workspaceState as? WorkspaceUiState.Content)?.let { content ->
      content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
    }
  // Bind the session to the FOCUSED (observed) device ONLY. setActiveDevice is allocation-bearing —
  // it reserves the device for this session — so it must never run for a device the user isn't
  // observing: registering the session by reserving a booted grid device would hold that device
  // hostage from CLI/MCP sessions for as long as the app sits on the home grid (Codex P1). The
  // daemon has no registration-only session path today (a session is created only by allocating a
  // device, and daemon/heartbeat rejects unknown sessions), so the pristine home grid's live
  // thumbnails are left to authenticate via the first observe — until then they degrade to the
  // screenshot fallback. Once any device is observed the session is registered, and the reopened
  // grid's other (unowned) devices then pass the stream auth's unowned-device branch.
  // A focus change cancels this effect, but the cancellation cannot interrupt an in-flight
  // synchronous setActiveDevice on Dispatchers.IO. Serialize binds through a mutex and gate each on
  // a generation token so a stale bind that finishes after its replacement cannot leave the session
  // pinned to the previously-focused device (mirrors AutoMobileContent's binding path).
  val bindingMutex = remember(desktopDaemonSession) { Mutex() }
  val bindingGeneration = remember(desktopDaemonSession) { AtomicLong(0L) }
  LaunchedEffect(
    desktopDaemonSession,
    resourceClient,
    focusedColumn?.deviceId,
    focusedColumn?.platform,
  ) {
    val session = desktopDaemonSession ?: return@LaunchedEffect
    val column = focusedColumn ?: return@LaunchedEffect
    val platform = column.platform.wireName()
    val generation = bindingGeneration.incrementAndGet()
    var refreshDeviceEpochs = false
    while (isActive) {
      val registered = runCatching {
        bindingMutex.withLock {
          // A newer focus superseded us while we waited for the lock — abandon quietly.
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(Dispatchers.IO) { session.client.setActiveDevice(column.deviceId, platform) }
        }
      }
        .onFailure {
          LOG.warn("Failed to bind desktop session to ${column.deviceId}: ${it.message}")
        }
        .isSuccess
      // Do not keep or heartbeat a binding a newer focus already replaced.
      if (bindingGeneration.get() != generation) return@LaunchedEffect
      if (!registered) {
        delay(DESKTOP_SESSION_HEARTBEAT_MS)
        continue
      }
      // Registered: heartbeat until one fails, then fall through to re-register.
      var alive = true
      while (isActive && alive) {
        if (refreshDeviceEpochs) {
          val sessionUuids = runCatching {
            withContext(Dispatchers.IO) {
              resourceClient.readResource(BOOTED_DEVICES_RESOURCE_URI)
            }
          }
            .onFailure {
              LOG.warn("Failed to refresh device epochs after daemon recovery: ${it.message}")
            }
            .getOrNull()
            ?.let { result ->
              when (result) {
                is ResourceReadResult.Success -> parseBootedDeviceSessionUuids(result.content)
                is ResourceReadResult.Error -> {
                  LOG.warn(
                    "Failed to refresh device epochs after daemon recovery: ${result.message}"
                  )
                  emptyMap()
                }
              }
            }
            .orEmpty()
          if (sessionUuids.isNotEmpty()) {
            workspaceViewModel.onAction(WorkspaceAction.RefreshDeviceSessionUuids(sessionUuids))
            refreshDeviceEpochs = false
          }
        }
        delay(DESKTOP_SESSION_HEARTBEAT_MS)
        alive =
          runCatching { withContext(Dispatchers.IO) { session.heartbeat() } }
            .onFailure { LOG.warn("Desktop daemon session lapsed, re-registering: ${it.message}") }
            .isSuccess
      }
      if (!alive) refreshDeviceEpochs = true
    }
  }

  // Window-level ⌘K/Ctrl+K (Main.kt) bumps openPaletteRequest; open the palette in response, but
  // only while the workspace is showing — onboarding and the device grid (shown while nothing is
  // observed, or when explicitly opened) own the screen and have no palette. The `> 0` guard skips
  // the initial composition (the counter starts at 0).
  LaunchedEffect(openPaletteRequest) {
    if (
      openPaletteRequest > 0 &&
        !showOnboarding &&
        !pickerOpen &&
        workspaceState is WorkspaceUiState.Content
    ) {
      paletteOpen = true
    }
  }

  // OpenPicker (from the empty state or the Devices launcher) shows the picker; observing selected
  // devices turns them into workspace columns.
  LaunchedEffect(workspaceViewModel) {
    workspaceViewModel.effect.collect { effect ->
      when (effect) {
        is WorkspaceEffect.OpenPicker -> {
          pickerViewModel.onAction(DevicePickerAction.Refresh)
          pickerOpen = true
        }
      }
    }
  }

  // Keep each pane's lock state fresh so the contextual Unlock control appears/disappears as the
  // device locks/unlocks. Untested IO poll (mirrors rememberDaemonConnectionState); the VM's
  // SetLockStates handler is the pinned behavior. Gated on observed columns so an idle workspace
  // is silent; while panes are open it re-reads the lightweight lockStates resource, falling back
  // to the full booted-devices resource for older daemons that lack it — see LOCK_STATE_POLL_MS.
  LaunchedEffect(workspaceViewModel, resourceClient) {
    while (true) {
      val hasColumns =
        (workspaceViewModel.state.value as? WorkspaceUiState.Content)?.columns?.isNotEmpty() == true
      if (hasColumns) {
        val states =
          try {
            when (
              val result =
                withContext(Dispatchers.IO) {
                  resourceClient.readResource(DEVICE_LOCK_STATES_RESOURCE_URI)
                }
            ) {
              is ResourceReadResult.Success -> parseDeviceLockStates(result.content)
              // An older daemon (reached over a non-reconciling HTTP/STDIO transport) doesn't
              // expose the lightweight lockStates resource; fall back to the full booted-devices
              // resource, which also carries each device's lock flag, so the Unlock control keeps
              // tracking reality instead of going permanently stale.
              is ResourceReadResult.Error ->
                when (
                  val booted =
                    withContext(Dispatchers.IO) {
                      resourceClient.readResource(BOOTED_DEVICES_RESOURCE_URI)
                    }
                ) {
                  is ResourceReadResult.Success -> parseBootedLockStates(booted.content)
                  is ResourceReadResult.Error -> emptyMap()
                }
            }
          } catch (cancellation: CancellationException) {
            throw cancellation
          } catch (error: Exception) {
            LOG.warn("Lock-state poll failed: ${error.message}", error)
            emptyMap()
          }
        if (states.isNotEmpty()) {
          workspaceViewModel.onAction(WorkspaceAction.SetLockStates(states))
        }
      }
      delay(LOCK_STATE_POLL_MS)
    }
  }
  LaunchedEffect(pickerViewModel) {
    pickerViewModel.effect.collect { effect ->
      if (effect is DevicePickerEffect.Observe) {
        effect.columns.forEach { workspaceViewModel.onAction(WorkspaceAction.ObserveDevice(it)) }
        pickerOpen = false
      }
    }
  }
  // Returning to the home grid (the last workspace column closed) refreshes the picker so it
  // reflects
  // devices started/killed externally during the workspace session — otherwise the picker only
  // loads
  // on init and via OpenPicker, so a stale grid could dispatch the wrong observe/boot (Codex P2).
  // Only the Content -> Empty transition refreshes; the initial Empty is already covered by the
  // VM's
  // init load.
  LaunchedEffect(pickerViewModel) {
    var wasContent = false
    snapshotFlow { workspaceState is WorkspaceUiState.Empty }
      .collect { empty ->
        if (empty && wasContent) pickerViewModel.onAction(DevicePickerAction.Refresh)
        wasContent = !empty
      }
  }
  // While the device grid is the visible surface — nothing observed, or the picker opened over a
  // workspace — poll for device changes so devices started/killed by another client appear while
  // the
  // user sits on the grid. Keyed on the DERIVED visibility (recomputed each recomposition), so the
  // loop starts when the grid appears and stops when it hides, instead of reading state captured at
  // launch: onboarding→grid and Devices+→overlay transitions both (re)start polling (Codex P2). A
  // silent reload keeps the grid on screen between polls.
  val gridVisible = !showOnboarding && (pickerOpen || workspaceState is WorkspaceUiState.Empty)
  LaunchedEffect(pickerViewModel, gridVisible) {
    if (!gridVisible) return@LaunchedEffect
    while (true) {
      delay(GRID_REFRESH_POLL_MS)
      pickerViewModel.onAction(DevicePickerAction.SilentRefresh)
    }
  }
  // A failed first load is otherwise a dead end (SilentRefresh only polls from Content): retry it
  // automatically ONCE per disconnected -> connected transition of the daemon health poll — the
  // "daemon was down, now it's back" recovery. Latching on the transition (not on the Error state)
  // means a read that keeps failing WHILE the daemon stays connected (e.g. a malformed payload) is
  // not retried in a Loading/Error flash loop every few seconds; that persistent case stays on the
  // explicit Retry button, as does a bootstrap failure with no daemon at all.
  val daemonUp = daemonConnectionState is ConnectionState.Connected
  var wasDaemonUp by remember(pickerViewModel) { mutableStateOf(daemonUp) }
  LaunchedEffect(pickerViewModel, daemonUp) {
    val cameUp = daemonUp && !wasDaemonUp
    wasDaemonUp = daemonUp
    if (!cameUp) return@LaunchedEffect
    // Short settle so the freshly (re)started daemon finishes binding its resources.
    delay(GRID_REFRESH_POLL_MS)
    // Read the live state flow after the settle — explicitly, not through the composition's
    // delegated property — so only a picker that is STILL failed reloads; a Retry the user
    // pressed during the settle (now Loading/Content) is never overlapped by a second refresh.
    if (pickerViewModel.state.value is DevicePickerUiState.Error) {
      pickerViewModel.onAction(DevicePickerAction.Refresh)
    }
  }

  AutoMobileTheme(themeMode = settings.themeMode) {
    Surface(
      modifier = Modifier.fillMaxSize(),
      color = MaterialTheme.colorScheme.background,
    ) {
      // Device-tab workspace is the desktop app root (replaces ThreePaneShell). AutoMobileContent
      // is retained and still used by the IDE plugin; dashboards return as workspace facets in
      // follow-up PRs. menuBarActions is plumbed for later re-wiring once facets/panes exist.
      //
      // The launch surfaces (onboarding + device picker) have no top bar to host the "update ready"
      // pill, so a user who never observes a device would never see the affordance even though the
      // startup check already ran (#5271). The workspace keeps its integrated top-bar pill; these
      // surfaces get a shared floating affordance instead, hosted above the surface switch so it is
      // reachable from either one. It self-hides unless updateStatus is UpdateAvailable.
      val onLaunchSurface = showOnboarding || pickerOpen || workspaceState is WorkspaceUiState.Empty
      Box(Modifier.fillMaxSize()) {
        when {
          showOnboarding ->
            OnboardingScreen(
              onGetStarted = {
                settings.hasSeenOnboarding = true
                showOnboarding = false
              }
            )
          // The device grid is the home surface whenever nothing is observed (true on launch), and
          // also whenever "Devices +" explicitly opens it over a live workspace. Observing a device
          // makes the workspace non-empty, which drops the picker for WorkspaceShell.
          pickerOpen || workspaceState is WorkspaceUiState.Empty ->
            DevicePicker(
              state = pickerState,
              onAction = pickerViewModel::onAction,
              onClose = { pickerOpen = false },
              // Only offer Close when there is an observed workspace to return to.
              canClose = workspaceState is WorkspaceUiState.Content,
              bootstrapState = bootstrapState,
            )
          else ->
            Box(Modifier.fillMaxSize()) {
              // Pause every pane's live video when this window is unfocused or minimized (#5219):
              // the grid thumbnails are one-shot screenshots, so the panes are the only standing
              // decode/encode cost. Focus is read once here and threaded into both pane surfaces
              // (stream + inspect), so an unfocused window disconnects all pane sources and a
              // refocus reconnects them via the existing auto-reconnect machinery.
              val streamingEnabled = LocalWindowInfo.current.isWindowFocused

              // Roll live connection health up into the top-bar status dot. The daemon signal is
              // polled here; per-device stream health is not yet fed in — device streams are
              // facet-owned and carry screenshots, so opening extra status-only streams would be
              // wasteful. deriveWorkspaceStatus already handles the device dimension, so it can be
              // fed once a central per-device stream registry exists (follow-up).
              val workspaceStatus =
                remember(daemonConnectionState) {
                  deriveWorkspaceStatus(daemon = daemonConnectionState, devices = emptyList())
                }

              WorkspaceShell(
                state = workspaceState,
                onAction = workspaceViewModel::onAction,
                onOpenPicker = workspaceViewModel::openPicker,
                onOpenPalette = { paletteOpen = true },
                // The ⌘K command palette is a sibling overlay hosted here (not inside the shell),
                // so isolate the whole workspace behind it — matching how the shell isolates its
                // own scrimmed panels — to keep the palette modal to keyboard/a11y focus (#4846).
                modifier = Modifier.isolatedBehindOverlay(paletteOpen),
                status = workspaceStatus.status,
                statusDetail = workspaceStatus.detail,
                updateStatus = updateStatus,
                onUpdateClick = { showUpdateDetails = true },
                facetContent = { column, tool -> WorkspaceFacet(column, tool) },
                // Inspect mode's Layout inspector renders live video for its pixels; the session
                // provider authenticates that subscribe against the stream-socket guard (#4751),
                // exactly as the stream pane below.
                inspectContent = { column ->
                  LayoutFacet(
                    column,
                    sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
                    streamingEnabled = streamingEnabled,
                  )
                },
                // Live device mirror in each pane's stream area, fed by the daemon's video-stream
                // relay. The pane authenticates with the workspace daemon session (#4977) bound to
                // the focused device above; when no session is available (non-Unix daemon, or the
                // bind failed) the provider yields null and the pane shows the auth refusal, with
                // AUTOMOBILE_DAEMON_STREAM_AUTH=0 as the operator escape hatch.
                streamContent = { column ->
                  // Tap-to-control is armed ONLY for the FOCUSED pane on a Unix daemon.
                  //  - Unix: the other transports (MCP HTTP/STDIO) don't serve the direct `input/*`
                  //    helpers, so `workspaceControlClientProvider` yields null there and a tap
                  // could
                  //    never reach the device — arming would only pay for a High-fps stream + an
                  //    observation stream that drive nothing.
                  //  - Focused: only one pane is being driven at a time. Gating on focus keeps the
                  //    unfocused farm panes as cheap Low-fps mirrors (no per-pane observation
                  // stream)
                  //    and means only the focused pane requests Compose keyboard focus, so a second
                  //    pane arming can't silently steal keystrokes mid-type (#5217). Click a pane
                  // to
                  //    focus (and thus drive) it; the single-device case is always focused.
                  val controlActive =
                    graph.autoMobileClient.transportName == "Unix Socket" &&
                      (workspaceState as? WorkspaceUiState.Content)?.focusedDeviceId ==
                        column.deviceId
                  val control =
                    rememberWorkspaceDeviceControl(
                      column = column,
                      clientProvider = workspaceControlClientProvider,
                      enabled = controlActive,
                    )
                  DeviceStreamView(
                    column,
                    sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
                    enableDeviceControl = controlActive,
                    control = control,
                    // Wires the per-pane quality overlay (manual Low/Medium/High + live FPS +
                    // auto-adjust) and persists the choice across sessions.
                    settings = settings,
                    streamingEnabled = streamingEnabled,
                  )
                },
              )
              if (paletteOpen) {
                CommandPalette(
                  commands =
                    buildWorkspaceCommands(
                      workspaceState,
                      onOpenPicker = workspaceViewModel::openPicker,
                      onAction = workspaceViewModel::onAction,
                    ),
                  onDismiss = { paletteOpen = false },
                )
              }

              // Details popup for the top-bar update pill (#5225). `as?` closes it automatically if
              // the
              // status leaves UpdateAvailable while open. Applying the update is a later item, so
              // the
              // install action inside is disabled.
              val availableUpdate = updateStatus as? UpdateStatus.UpdateAvailable
              if (showUpdateDetails && availableUpdate != null) {
                // Anchor the popup under the top-right pill (below the 40dp top bar) rather than
                // the
                // window's default top-left, so it reads as coming from its trigger.
                val popupOffset =
                  with(LocalDensity.current) {
                    IntOffset(x = -8.dp.roundToPx(), y = 44.dp.roundToPx())
                  }
                Popup(
                  alignment = Alignment.TopEnd,
                  offset = popupOffset,
                  onDismissRequest = { showUpdateDetails = false },
                  properties = PopupProperties(focusable = true),
                ) {
                  Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.surface,
                    shadowElevation = 8.dp,
                  ) {
                    UpdateDetailsContent(
                      update = availableUpdate,
                      currentVersion = graph.appVersionProvider.current().raw,
                      onOpenReleaseNotes = {
                        availableUpdate.releaseNotesUrl?.let { openReleaseNotesInBrowser(it) }
                      },
                      // Only a Conveyor package can apply in place; the GitHub path reports false
                      // and
                      // the install action stays disabled. Conveyor tears the app down as it
                      // restarts,
                      // so this is the last thing the process does.
                      onInstall =
                        if (updateController.canApplyUpdate()) {
                          { scope.launch { updateController.applyUpdate() } }
                        } else {
                          null
                        },
                    )
                  }
                }
              }
            }
        }

        // Shared floating "update ready" affordance for the launch surfaces (#5271). Clicking it
        // opens the same UpdateDetailsContent the workspace pill uses, wired to apply-in-place only
        // when the packaging supports it (canApplyUpdate) — the GitHub-Releases path leaves the
        // install action disabled until the apply item (#5226) lands.
        if (onLaunchSurface) {
          FloatingUpdateAffordance(
            status = updateStatus,
            currentVersion = graph.appVersionProvider.current().raw,
            onOpenReleaseNotes = {
              (updateStatus as? UpdateStatus.UpdateAvailable)?.releaseNotesUrl?.let {
                openReleaseNotesInBrowser(it)
              }
            },
            onInstall =
              if (updateController.canApplyUpdate()) {
                { scope.launch { updateController.applyUpdate() } }
              } else {
                null
              },
          )
        }
      }
    }
  }
}

/**
 * Real docked-facet content for a pane, wired to the per-device facets in desktop-core: Logs
 * (telemetry), Storage (auto-resolved app, Android + iOS), Network (per-device `getNetworkGraph`
 * tool call), Performance (per-device observation stream, filtered by deviceId), Failures
 * (cross-device aggregate), Navigation (#4837 Phase C — app-scoped graph pulled by the pane
 * device's foreground app), and Test (per-device test-runs daemon resource, #4715 / #5017 — scoped
 * to the pane device by deviceId).
 */
@Composable
private fun WorkspaceFacet(column: DeviceColumn, tool: Tool) {
  when (tool) {
    Tool.Logs -> LogsFacet(column)
    // Storage works on both platforms now that iOS key-value mutations carry the platform to the
    // daemon and target the correct iOS device (#4708).
    Tool.Storage -> StorageFacet(column)
    // Network reads per-device via the getNetworkGraph MCP tool call (deviceId is an argument),
    // not the broadcast observation stream, so panes don't cross-contaminate.
    Tool.Network -> NetworkFacet(column)
    Tool.Performance -> PerformanceFacet(column)
    Tool.Failures -> FailuresFacet(column)
    // Navigation is app-scoped (#4837 Phase C): the facet resolves the pane device's foreground app
    // from the stream, then pulls that app's persisted graph by appId — so same-app panes share the
    // graph and a foreign broadcast can't overwrite a pane (the #4838 contamination).
    Tool.Navigation -> NavigationFacet(column)
    // Test reads the per-device test-runs daemon resource (automobile:test-runs?deviceId=<id>,
    // #4715 / #5017), scoped to the pane device so panes don't cross-contaminate (#5019).
    Tool.Test -> TestFacet(column)
  }
}
