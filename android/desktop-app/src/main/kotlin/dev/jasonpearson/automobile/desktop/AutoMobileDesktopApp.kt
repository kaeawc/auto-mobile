package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
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
import dev.jasonpearson.automobile.desktop.core.daemon.CoalescingRecoveryLauncher
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import dev.jasonpearson.automobile.desktop.core.daemon.InputAllocatingClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.rememberDesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.rememberPaneSessionUuidProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.layout.DeviceBindErrorNotice
import dev.jasonpearson.automobile.desktop.core.layout.DeviceIdleReleasedNotice
import dev.jasonpearson.automobile.desktop.core.layout.DeviceViewingNotice
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.settings.SettingsPanel
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.AboutDialog
import dev.jasonpearson.automobile.desktop.core.shell.FloatingUpdateAffordance
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.shell.UpdateDetailsContent
import dev.jasonpearson.automobile.desktop.core.shell.openReleaseNotesInBrowser
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import dev.jasonpearson.automobile.desktop.core.workspace.BOOTED_DEVICES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.CommandPalette
import dev.jasonpearson.automobile.desktop.core.workspace.DEVICE_LOCK_STATES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.DaemonEmulatorControlExecutor
import dev.jasonpearson.automobile.desktop.core.workspace.DesktopOverlayState
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceSessionSupersededForwarder
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceStreamView
import dev.jasonpearson.automobile.desktop.core.workspace.FailuresFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LayoutFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LogsFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NetworkFacet
import dev.jasonpearson.automobile.desktop.core.workspace.ObservationForegroundAppResolver
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("AutoMobileDesktopApp")

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
  menuBarActions: MenuBarActions = remember { MenuBarActions() },
  openPaletteRequest: Int = 0,
  // Hoisted from the single app-level DaemonConnectionMonitor in Main.kt so the status dot and the
  // system-tray icon share one daemon-health source instead of each running its own 5s poll
  // (#4858).
  daemonConnectionState: ConnectionState = ConnectionState.Connecting,
  // False while the window is closed to the tray (#10695): after a short grace the desktop session
  // releases the device it holds, and showing the window allocates it again on the next input.
  windowVisible: Boolean = true,
) {
  val graph = LocalAutoMobileGraph.current

  // The devices the workspace panes show (#10730). Watching them allocates nothing; the session
  // allocates the one the user sends input to, and holds it while its pane stays open.
  val desktopSessionPanes = remember {
    mutableStateOf<List<DesktopDaemonSessionBinding>>(emptyList())
  }
  var refreshAfterDaemonRecovery by remember { mutableStateOf<suspend () -> Boolean>({ true }) }
  // Resolved once, not per recomposition: the path lookup is process-wide cached (#10238) but the
  // root must not call into it at all on the UI thread.
  val usesUnixSocket = graph.autoMobileClient.transportName == "Unix Socket"
  val desktopSocketPath =
    remember(usesUnixSocket) { if (usesUnixSocket) DaemonSocketPaths.socketPath() else null }
  val desktopSessionState =
    rememberDesktopDaemonSession(
      desktopSocketPath,
      desktopSessionPanes,
      hostVisible = windowVisible,
    ) {
      refreshAfterDaemonRecovery()
    }
  val desktopDaemonSession = desktopSessionState.session
  // Identity changes only with the session or its registration (#10231), never on an unrelated
  // root recomposition, so the facets' sockets stay connected while a divider is dragged.
  val paneSessionUuidProvider = rememberPaneSessionUuidProvider(desktopSessionState)

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
  // The daemon accepts input for a held device only from its holder (#10698), so every input path
  // names the desktop session, read per frame so a session rotation is picked up.
  val latestSessionUuidProvider by rememberUpdatedState(desktopSessionState.sessionUuidProvider)
  val desktopInputSessionUuid: () -> String? = remember { { latestSessionUuidProvider() } }
  // A daemon refusal of a pane's input or control (`device_owned_by_other_session`) shows the
  // pane's held-elsewhere notice instead of only reaching the log (#10743, #10783).
  val latestReportHeldElsewhere by rememberUpdatedState(desktopSessionState.reportHeldElsewhere)
  val reportHeldElsewhere: (String) -> Unit = remember { { latestReportHeldElsewhere(it) } }
  // Input is active tool use and watching is not (#10730): every input path, the pane's device
  // controls included, allocates its device to the desktop session first and drops the input when
  // it cannot. The allocation is stable per
  // socket, so a session rotation does not rebuild the clients or the view model keyed on them.
  val inputAllocation = desktopSessionState.inputAllocation
  val desktopInputClient =
    remember(graph, inputAllocation) {
      if (graph.autoMobileClient.transportName == "Unix Socket") {
        InputAllocatingClient(
          McpDaemonClient(
            DaemonSocketPaths.socketPath(),
            inputSessionUuidProvider = desktopInputSessionUuid,
          ),
          inputAllocation,
          // Rotate, snapshot, unlock and locale run as the desktop session that holds the device.
          sessionUuidProvider = desktopInputSessionUuid,
        )
      } else {
        graph.autoMobileClient
      }
    }
  val controlExecutor =
    remember(graph, desktopDaemonSession, desktopInputClient) {
      DaemonEmulatorControlExecutor(
        graph.autoMobileClient,
        inputClient = desktopInputClient,
        foregroundAppResolver =
          ObservationForegroundAppResolver(
            sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
          ),
      )
    }
  val workspaceViewModel =
    remember(scope, controlExecutor) { WorkspaceViewModel(scope, controlExecutor) }
  val workspaceState by workspaceViewModel.state.collectAsState()
  val supersededForwarder =
    remember(workspaceViewModel) {
      DeviceSessionSupersededForwarder(
        columns = {
          (workspaceViewModel.state.value as? WorkspaceUiState.Content)?.columns.orEmpty()
        },
        dispatch = workspaceViewModel::onAction,
      )
    }

  val resourceClient = remember(graph) { DaemonMcpResourceClient(graph.autoMobileClient) }
  val refreshDesktopSessionState: suspend () -> Boolean =
    remember(resourceClient, workspaceViewModel) {
      {
        val sessionUuids = runCatching {
          withContext(Dispatchers.IO) { resourceClient.readResource(BOOTED_DEVICES_RESOURCE_URI) }
        }
          .onFailure {
            LOG.warn("Failed to refresh device epochs after daemon recovery: ${it.message}")
          }
          .getOrNull()
          ?.let { result ->
            when (result) {
              is ResourceReadResult.Success -> parseBootedDeviceSessionUuids(result.content)
              is ResourceReadResult.Error -> {
                LOG.warn("Failed to refresh device epochs after daemon recovery: ${result.message}")
                emptyMap()
              }
            }
          }
          .orEmpty()
        if (sessionUuids.isNotEmpty()) {
          workspaceViewModel.onAction(WorkspaceAction.RefreshDeviceSessionUuids(sessionUuids))
        }
        sessionUuids.isNotEmpty()
      }
    }
  SideEffect { refreshAfterDaemonRecovery = refreshDesktopSessionState }
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
  // Coalescing launcher for the workspace health sheet's "Start daemon" recovery button (#6080): it
  // makes a synchronous in-flight claim before dispatching ensureReady() off the main thread and
  // drops clicks while a pass is running, so rapid clicks (or clicks before bootstrapState's own
  // Working phase catches up) don't queue duplicate startup-budget passes. Its inFlight flag backs
  // the button's disabled state.
  val recoveryLauncher =
    remember(scope, daemonBootstrap) {
      CoalescingRecoveryLauncher(scope = scope, recover = { daemonBootstrap.ensureReady() })
    }
  val recoveringDaemon by recoveryLauncher.inFlight.collectAsState()
  var paletteOpen by remember { mutableStateOf(false) }
  var overlayState by remember { mutableStateOf(DesktopOverlayState.None) }
  val showSettings = overlayState == DesktopOverlayState.Settings
  val showAbout = overlayState == DesktopOverlayState.About
  var captureRequest by remember { mutableStateOf<Pair<String, Int>?>(null) }
  var showOnboarding by remember { mutableStateOf(!settings.hasSeenOnboarding) }

  LaunchedEffect(menuBarActions.showAbout) {
    if (menuBarActions.showAbout) {
      overlayState = overlayState.openAbout()
      menuBarActions.showAbout = false
    }
  }
  LaunchedEffect(menuBarActions.showSettings) {
    if (menuBarActions.showSettings) {
      overlayState = overlayState.openSettings()
      menuBarActions.showSettings = false
    }
  }
  LaunchedEffect(menuBarActions.showCommandPalette) {
    if (menuBarActions.showCommandPalette) {
      if (
        !showOnboarding &&
          !pickerOpen &&
          !showSettings &&
          !showAbout &&
          workspaceState is WorkspaceUiState.Content
      ) {
        paletteOpen = true
      }
      menuBarActions.showCommandPalette = false
    }
  }
  DisposableEffect(menuBarActions, workspaceState, showOnboarding, pickerOpen) {
    menuBarActions.onTakeScreenshot = {
      if (!showOnboarding && !pickerOpen) {
        (workspaceState as? WorkspaceUiState.Content)?.focusedDeviceId?.let { deviceId ->
          captureRequest = deviceId to ((captureRequest?.second ?: 0) + 1)
        }
      }
    }
    onDispose { menuBarActions.onTakeScreenshot = null }
  }

  // Per-tap client factory for workspace device control. The DeviceControlSession closes the client
  // it mints per action, so this MUST return a fresh McpDaemonClient each call, never the shared
  // graph.autoMobileClient. Non-Unix transports don't support device input, so they yield null and
  // the pane stays a display-only mirror.
  val workspaceControlClientProvider: () -> AutoMobileClient? =
    remember(graph, inputAllocation) {
      if (graph.autoMobileClient.transportName == "Unix Socket") {
        // Resolve once: this provider runs per input action.
        val socketPath = DaemonSocketPaths.socketPath()
        val provider: () -> AutoMobileClient? = {
          InputAllocatingClient(
            McpDaemonClient(socketPath, inputSessionUuidProvider = desktopInputSessionUuid),
            inputAllocation,
          )
        }
        provider
      } else {
        { null }
      }
    }
  // Every open pane is watched; none is allocated until the user sends it input (#10730). Closing
  // a pane releases the device the session holds for it.
  val paneBindings =
    (workspaceState as? WorkspaceUiState.Content)?.columns.orEmpty().map {
      DesktopDaemonSessionBinding(it.deviceId, it.platform.wireName())
    }
  SideEffect { desktopSessionPanes.value = paneBindings }

  // Window-level ⌘K/Ctrl+K (Main.kt) bumps openPaletteRequest; open the palette in response, but
  // only while the workspace is showing — onboarding and the device grid (shown while nothing is
  // observed, or when explicitly opened) own the screen and have no palette. The `> 0` guard skips
  // the initial composition (the counter starts at 0).
  LaunchedEffect(openPaletteRequest) {
    if (
      openPaletteRequest > 0 &&
        !showOnboarding &&
        !pickerOpen &&
        !showSettings &&
        !showAbout &&
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
        is WorkspaceEffect.DeviceHeldElsewhere -> reportHeldElsewhere(effect.deviceId)
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
      // follow-up PRs.
      //
      // The launch surfaces (onboarding + device picker) have no top bar to host the "update ready"
      // pill, so a user who never observes a device would never see the affordance even though the
      // startup check already ran (#5271). The workspace keeps its integrated top-bar pill; these
      // surfaces get a shared floating affordance instead, hosted above the surface switch so it is
      // reachable from either one. It self-hides unless updateStatus is UpdateAvailable.
      val onLaunchSurface = showOnboarding || pickerOpen || workspaceState is WorkspaceUiState.Empty
      Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().isolatedBehindOverlay(showSettings || showAbout)) {
          when {
            showOnboarding ->
              OnboardingScreen(
                onGetStarted = {
                  settings.hasSeenOnboarding = true
                  showOnboarding = false
                },
              )
            // The device grid is the home surface whenever nothing is observed (true on launch),
            // and
            // also whenever "Devices +" explicitly opens it over a live workspace. Observing a
            // device
            // makes the workspace non-empty, which drops the picker for WorkspaceShell.
            pickerOpen || workspaceState is WorkspaceUiState.Empty ->
              DevicePicker(
                state = pickerState,
                onAction = pickerViewModel::onAction,
                onClose = { pickerOpen = false },
                // Only offer Close when there is an observed workspace to return to.
                canClose = workspaceState is WorkspaceUiState.Content,
                bootstrapState = bootstrapState,
                // Retry shares the workspace status-dot's coalescing recovery (#6082 / #6080), so a
                // wedged daemon is restarted rather than short-circuited past; a no-op on an
                // inactive
                // (non-daemon) transport.
                onRecoverDaemon = { recoveryLauncher.launch() },
                sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
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
                // wasteful. deriveWorkspaceStatus already handles the device dimension, so it can
                // be
                // fed once a central per-device stream registry exists (follow-up).
                val workspaceStatus =
                  remember(daemonConnectionState) {
                    deriveWorkspaceStatus(daemon = daemonConnectionState, devices = emptyList())
                  }

                WorkspaceShell(
                  state = workspaceState,
                  onAction = workspaceViewModel::onAction,
                  onDeviceSessionSuperseded = supersededForwarder::onSuperseded,
                  onOpenPicker = workspaceViewModel::openPicker,
                  onOpenPalette = { paletteOpen = true },
                  externalCaptureRequest = captureRequest,
                  // The ⌘K command palette is a sibling overlay hosted here (not inside the shell),
                  // so isolate the whole workspace behind it — matching how the shell isolates its
                  // own scrimmed panels — to keep the palette modal to keyboard/a11y focus (#4846).
                  modifier = Modifier.isolatedBehindOverlay(paletteOpen),
                  status = workspaceStatus.status,
                  statusDetail = workspaceStatus.detail,
                  // Health-sheet recovery affordance (#6035): reuse the picker's DaemonBootstrap
                  // seam
                  // so the workspace red dot can start/restart the daemon. ensureReady() blocks up
                  // to
                  // the startup budget, so it runs off the main thread; its phases flow back into
                  // bootstrapState (narrating the in-flight button) and the existing session
                  // re-register loop self-heals the panes once the daemon is reachable. A no-op for
                  // a
                  // non-daemon (Inactive) transport, so the affordance is inert on HTTP/STDIO.
                  bootstrapState = bootstrapState,
                  recovering = recoveringDaemon,
                  // Delegate to the coalescing launcher (#6080) so a rapid second click can't queue
                  // a
                  // duplicate ensureReady() pass; the guard itself lives in
                  // CoalescingRecoveryLauncher
                  // where it is unit-tested.
                  onRecoverDaemon = { recoveryLauncher.launch() },
                  updateStatus = updateStatus,
                  onUpdateClick = { showUpdateDetails = true },
                  facetContent = { column, tool ->
                    WorkspaceFacet(
                      column,
                      tool,
                      // A newly registered session recomposes the facets because the provider's
                      // identity changes with registration; unrelated root recompositions do not.
                      sessionUuidProvider = paneSessionUuidProvider,
                    )
                  },
                  observationStreamFactory = {
                    ObservationStreamClient(
                      sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
                    )
                  },
                  sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
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
                  // relay. The pane authenticates with the workspace daemon session (#4977), which
                  // the daemon admits as a viewer whether or not it holds the device (#10698);
                  // when no session is available (non-Unix daemon, or registration failed) the
                  // provider yields null and the pane shows the auth refusal, with
                  // AUTOMOBILE_DAEMON_STREAM_AUTH=0 as the operator escape hatch.
                  streamContent = { column ->
                    // Tap-to-control is armed ONLY for the FOCUSED pane on a Unix daemon.
                    //  - Unix: the other transports (MCP HTTP/STDIO) don't serve the direct
                    // `input/*`
                    //    helpers, so `workspaceControlClientProvider` yields null there and a tap
                    // could
                    //    never reach the device — arming would only pay for a High-fps stream + an
                    //    observation stream that drive nothing.
                    //  - Focused: only one pane is being driven at a time. Gating on focus keeps
                    // the
                    //    unfocused farm panes as cheap Low-fps mirrors (no per-pane observation
                    // stream)
                    //    and means only the focused pane requests Compose keyboard focus, so a
                    // second
                    //    pane arming can't silently steal keystrokes mid-type (#5217). Click a pane
                    // to
                    //    focus (and thus drive) it; the single-device case is always focused.
                    // Held elsewhere (#10660, #10730): an input was refused because another
                    // session holds this device, so the pane keeps mirroring it without control
                    // until the user explicitly takes control. Before any input every pane is
                    // plain watching, which allocates nothing and needs no notice.
                    val heldElsewhere = desktopSessionState.heldElsewhereDeviceId == column.deviceId
                    val focused =
                      (workspaceState as? WorkspaceUiState.Content)?.focusedDeviceId ==
                        column.deviceId
                    val controlActive =
                      graph.autoMobileClient.transportName == "Unix Socket" &&
                        focused &&
                        !heldElsewhere
                    // A bind that failed for another reason is an error, not held elsewhere
                    // (#10682).
                    val bindError =
                      desktopSessionState.bindErrorMessage?.takeIf {
                        desktopSessionState.bindErrorDeviceId == column.deviceId
                      }
                    // Released after inactivity: the pane stays controllable, and its next input
                    // allocates the device again (owner decision 2026-10-08).
                    val idleReleased = desktopSessionState.idleReleasedDeviceId == column.deviceId
                    val requestControl = desktopSessionState.requestControl
                    val takeControl =
                      remember(requestControl, column.deviceId) {
                        { requestControl(column.deviceId) }
                      }
                    // Input clients allocate the device on the first input (#10730).
                    val columnControlClientProvider = workspaceControlClientProvider
                    val control =
                      rememberWorkspaceDeviceControl(
                        column = column,
                        clientProvider = columnControlClientProvider,
                        enabled = controlActive,
                        sessionUuidProvider = paneSessionUuidProvider,
                        onDeviceHeldElsewhere = reportHeldElsewhere,
                      )
                    Box {
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
                      if (heldElsewhere) {
                        DeviceViewingNotice(
                          onTakeControl = takeControl,
                          modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                        )
                      } else if (idleReleased) {
                        DeviceIdleReleasedNotice(
                          reason = desktopSessionState.releaseReason,
                          onTakeControl = takeControl,
                          modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                        )
                      } else if (bindError != null) {
                        DeviceBindErrorNotice(
                          message = bindError,
                          onRetry = takeControl,
                          modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                        )
                      }
                    }
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

                // Details popup for the top-bar update pill (#5225). `as?` closes it automatically
                // if
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
          // opens the same UpdateDetailsContent the workspace pill uses, wired to apply-in-place
          // only
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
        if (showSettings) {
          SettingsPanel(
            settings = settings,
            onClose = { overlayState = overlayState.closeSettings() },
            clientProvider = { graph.autoMobileClient },
            modifier = Modifier.fillMaxSize(),
          )
        }
        if (showAbout) {
          AboutDialog(
            version = graph.appVersionProvider.current(),
            onDismiss = { overlayState = overlayState.closeAbout() },
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
private fun WorkspaceFacet(
  column: DeviceColumn,
  tool: Tool,
  sessionUuidProvider: () -> String? = { null },
) {
  when (tool) {
    Tool.Logs -> LogsFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Storage works on both platforms now that iOS key-value mutations carry the platform to the
    // daemon and target the correct iOS device (#4708).
    Tool.Storage -> StorageFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Network reads per-device via the getNetworkGraph MCP tool call (deviceId is an argument),
    // not the broadcast observation stream, so panes don't cross-contaminate.
    Tool.Network -> NetworkFacet(column)
    Tool.Performance -> PerformanceFacet(column, sessionUuidProvider = sessionUuidProvider)
    Tool.Failures -> FailuresFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Navigation is app-scoped (#4837 Phase C): the facet resolves the pane device's foreground app
    // from the stream, then pulls that app's persisted graph by appId — so same-app panes share the
    // graph and a foreign broadcast can't overwrite a pane (the #4838 contamination).
    Tool.Navigation -> NavigationFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Test reads the per-device test-runs daemon resource (automobile:test-runs?deviceId=<id>,
    // #4715 / #5017), scoped to the pane device so panes don't cross-contaminate (#5019).
    Tool.Test -> TestFacet(column)
  }
}
