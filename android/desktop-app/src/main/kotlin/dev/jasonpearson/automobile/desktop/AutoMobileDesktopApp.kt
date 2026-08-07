package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.BOOTED_DEVICES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.CommandPalette
import dev.jasonpearson.automobile.desktop.core.workspace.DEVICE_LOCK_STATES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.DaemonEmulatorControlExecutor
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceStreamView
import dev.jasonpearson.automobile.desktop.core.workspace.FailuresFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LogsFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NetworkFacet
import dev.jasonpearson.automobile.desktop.core.workspace.OnboardingScreen
import dev.jasonpearson.automobile.desktop.core.workspace.PerformanceFacet
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import dev.jasonpearson.automobile.desktop.core.workspace.StorageFacet
import dev.jasonpearson.automobile.desktop.core.workspace.Tool
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceEffect
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceFacetPlaceholder
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShell
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.buildWorkspaceCommands
import dev.jasonpearson.automobile.desktop.core.workspace.deriveWorkspaceStatus
import dev.jasonpearson.automobile.desktop.core.workspace.parseBootedLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.parseDeviceLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePicker
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerAction
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerEffect
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.RealDeviceBootController
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

// How often the top-bar status dot re-probes daemon connectivity. Matches the health sheet's
// read-only refresh cadence (WorkspaceShell.HEALTH_SHEET_REFRESH_MS).
private const val DAEMON_STATUS_POLL_MS = 5_000L

// How often each observed pane's lock state is re-read so the contextual Unlock control appears or
// disappears as the device locks/unlocks. Runs only while at least one device is observed. NOTE:
// it re-reads the whole booted-devices resource, which recomputes service status AND the keyguard
// probe for every booted device — not a free read. A lighter dedicated lock-state feed is a
// follow-up (see #4694); until then this cadence trades adb load for Unlock responsiveness.
private const val LOCK_STATE_POLL_MS = 4_000L

/**
 * Live daemon connectivity as a [ConnectionState], polled from [AutoMobileClient.getDaemonStatus].
 * A successful status call means the daemon socket is reachable ([ConnectionState.Connected]); a
 * throw means it is not ([ConnectionState.Disconnected]). Starts as [ConnectionState.Connecting]
 * until the first probe resolves.
 */
@Composable
private fun rememberDaemonConnectionState(client: AutoMobileClient): ConnectionState {
  var state by remember(client) { mutableStateOf<ConnectionState>(ConnectionState.Connecting) }
  LaunchedEffect(client) {
    while (true) {
      state =
        try {
          withContext(Dispatchers.IO) { client.getDaemonStatus() }
          ConnectionState.Connected()
        } catch (cancellation: CancellationException) {
          // Disposal cancels this effect; propagate it instead of logging a false daemon failure
          // and flipping the dot to disconnected during teardown.
          throw cancellation
        } catch (error: Exception) {
          // A failed status call means the daemon socket is unreachable; surface it as
          // disconnected so the status dot goes red. Logged so there is a trace behind the dot.
          LOG.warn("Daemon status poll failed: ${error.message}", error)
          ConnectionState.Disconnected(error.message)
        }
      delay(DAEMON_STATUS_POLL_MS)
    }
  }
  return state
}

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
) {
  val graph = LocalAutoMobileGraph.current
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
  // A focus change cancels this effect, but the cancellation cannot interrupt an in-flight
  // synchronous setActiveDevice on Dispatchers.IO. Serialize binds through a mutex and gate each on
  // a generation token so a stale bind that finishes after its replacement cannot leave the session
  // pinned to the previously-focused device (mirrors AutoMobileContent's binding path).
  val bindingMutex = remember(desktopDaemonSession) { Mutex() }
  val bindingGeneration = remember(desktopDaemonSession) { AtomicLong(0L) }
  LaunchedEffect(desktopDaemonSession, focusedColumn?.deviceId, focusedColumn?.platform) {
    val session = desktopDaemonSession ?: return@LaunchedEffect
    val column = focusedColumn ?: return@LaunchedEffect
    val platform = if (column.platform == Platform.Ios) "ios" else "android"
    val generation = bindingGeneration.incrementAndGet()
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
        delay(DESKTOP_SESSION_HEARTBEAT_MS)
        alive =
          runCatching { withContext(Dispatchers.IO) { session.heartbeat() } }
            .onFailure { LOG.warn("Desktop daemon session lapsed, re-registering: ${it.message}") }
            .isSuccess
      }
    }
  }

  // Window-level ⌘K/Ctrl+K (Main.kt) bumps openPaletteRequest; open the palette in response, but
  // only while the workspace is showing — onboarding and the device picker own the screen and have
  // no palette. The `> 0` guard skips the initial composition (the counter starts at 0).
  LaunchedEffect(openPaletteRequest) {
    if (openPaletteRequest > 0 && !showOnboarding && !pickerOpen) {
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

  AutoMobileTheme(themeMode = settings.themeMode) {
    Surface(
      modifier = Modifier.fillMaxSize(),
      color = MaterialTheme.colorScheme.background,
    ) {
      // Device-tab workspace is the desktop app root (replaces ThreePaneShell). AutoMobileContent
      // is retained and still used by the IDE plugin; dashboards return as workspace facets in
      // follow-up PRs. menuBarActions is plumbed for later re-wiring once facets/panes exist.
      when {
        showOnboarding ->
          OnboardingScreen(
            onGetStarted = {
              settings.hasSeenOnboarding = true
              showOnboarding = false
            }
          )
        pickerOpen ->
          DevicePicker(
            state = pickerState,
            onAction = pickerViewModel::onAction,
            onClose = { pickerOpen = false },
          )
        else ->
          Box(Modifier.fillMaxSize()) {
            // Roll live connection health up into the top-bar status dot. The daemon signal is
            // polled here; per-device stream health is not yet fed in — device streams are
            // facet-owned and carry screenshots, so opening extra status-only streams would be
            // wasteful. deriveWorkspaceStatus already handles the device dimension, so it can be
            // fed once a central per-device stream registry exists (follow-up).
            val daemonState = rememberDaemonConnectionState(graph.autoMobileClient)
            val workspaceStatus =
              remember(daemonState) {
                deriveWorkspaceStatus(daemon = daemonState, devices = emptyList())
              }
            WorkspaceShell(
              state = workspaceState,
              onAction = workspaceViewModel::onAction,
              onOpenPicker = workspaceViewModel::openPicker,
              onOpenPalette = { paletteOpen = true },
              status = workspaceStatus.status,
              statusDetail = workspaceStatus.detail,
              facetContent = { column, tool -> WorkspaceFacet(column, tool) },
              // Live device mirror in each pane's stream area, fed by the daemon's video-stream
              // relay. The pane authenticates with the workspace daemon session (#4977) bound to
              // the focused device above; when no session is available (non-Unix daemon, or the
              // bind failed) the provider yields null and the pane shows the auth refusal, with
              // AUTOMOBILE_DAEMON_STREAM_AUTH=0 as the operator escape hatch.
              streamContent = { column ->
                DeviceStreamView(
                  column,
                  sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
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
          }
      }
    }
  }
}

/**
 * Real docked-facet content for a pane, wired to the per-device facets in desktop-core: Logs
 * (telemetry), Storage (auto-resolved app, Android + iOS), Network (per-device `getNetworkGraph`
 * tool call), Performance (per-device observation stream, filtered by deviceId), Failures
 * (cross-device aggregate), and Navigation (#4837 Phase C — app-scoped graph pulled by the pane
 * device's foreground app). Test (per-device daemon resource, #4715) falls back to the placeholder
 * for now.
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
    // graph and a foreign broadcast can't overwrite a pane (the #4838 contamination). Test
    // (per-device daemon resource, #4715) still falls back to the placeholder.
    Tool.Navigation -> NavigationFacet(column)
    else -> WorkspaceFacetPlaceholder(tool)
  }
}
