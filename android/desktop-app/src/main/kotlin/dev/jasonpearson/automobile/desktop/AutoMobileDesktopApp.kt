package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
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
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.CommandPalette
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.FailuresFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LogsFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NetworkFacet
import dev.jasonpearson.automobile.desktop.core.workspace.OnboardingScreen
import dev.jasonpearson.automobile.desktop.core.workspace.PerformanceFacet
import dev.jasonpearson.automobile.desktop.core.workspace.StorageFacet
import dev.jasonpearson.automobile.desktop.core.workspace.Tool
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceEffect
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceFacetPlaceholder
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShell
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.buildWorkspaceCommands
import dev.jasonpearson.automobile.desktop.core.workspace.deriveWorkspaceStatus
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePicker
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerAction
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerEffect
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.RealDeviceBootController
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("AutoMobileDesktopApp")

// How often the top-bar status dot re-probes daemon connectivity. Matches the health sheet's
// read-only refresh cadence (WorkspaceShell.HEALTH_SHEET_REFRESH_MS).
private const val DAEMON_STATUS_POLL_MS = 5_000L

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
  val workspaceViewModel = remember(scope) { WorkspaceViewModel(scope) }
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
        // Emulator-control execution is deferred to #4694; drain + log the intent for now so the
        // effect channel doesn't back up. The control UI + intent contract ships in this PR.
        is WorkspaceEffect.RunControl ->
          LOG.info(
            "Emulator control ${effect.control} requested for ${effect.deviceId} " +
              "(${effect.platform}); execution deferred to #4694"
          )
      }
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
