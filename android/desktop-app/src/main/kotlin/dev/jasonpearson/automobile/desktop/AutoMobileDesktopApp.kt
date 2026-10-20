package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.FailuresFacet
import dev.jasonpearson.automobile.desktop.core.workspace.LogsFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet
import dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacetOptions
import dev.jasonpearson.automobile.desktop.core.workspace.NetworkFacet
import dev.jasonpearson.automobile.desktop.core.workspace.PerformanceFacet
import dev.jasonpearson.automobile.desktop.core.workspace.StorageFacet
import dev.jasonpearson.automobile.desktop.core.workspace.StorageFacetOptions
import dev.jasonpearson.automobile.desktop.core.workspace.TestFacet
import dev.jasonpearson.automobile.desktop.core.workspace.Tool

// How often each observed pane's lock state is re-read so the contextual Unlock control appears or
// disappears as the device locks/unlocks. Runs only while at least one device is observed. NOTE:
// it re-reads the whole booted-devices resource, which recomputes service status AND the keyguard
// probe for every booted device — not a free read. A lighter dedicated lock-state feed is a
// follow-up (see #4694); until then this cadence trades adb load for Unlock responsiveness.
internal const val LOCK_STATE_POLL_MS = 4_000L

// How often the device grid re-reads the device list while it is the visible surface, so devices
// started/killed by another client appear without a manual refresh. Matches AutoMobileContent's
// booted-devices poll cadence.
internal const val GRID_REFRESH_POLL_MS = 5_000L

/**
 * Wraps a [SettingsProvider] so that [themeMode] is backed by Compose snapshot state, enabling
 * recomposition when the user changes the theme in settings.
 */
internal class ObservableSettingsProvider(private val delegate: SettingsProvider) :
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
  val runtime = rememberDesktopRuntime(windowVisible)
  val ui = remember { DesktopAppUiState(runtime.settings) }
  val presentation = desktopPresentation(runtime, daemonConnectionState)
  DesktopMenuEffects(presentation, ui, menuBarActions, openPaletteRequest)
  DesktopWorkspaceEffects(presentation, ui)
  DesktopLockStateEffect(presentation)
  DesktopGridEffects(presentation, ui)
  DesktopAppSurface(presentation, ui)
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
internal fun WorkspaceFacet(
  column: DeviceColumn,
  tool: Tool,
  sessionUuidProvider: () -> String? = { null },
  inputAllocation: DesktopInputAllocation? = null,
) {
  when (tool) {
    Tool.Logs -> LogsFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Storage works on both platforms now that iOS key-value mutations carry the platform to the
    // daemon and target the correct iOS device (#4708).
    Tool.Storage ->
      StorageFacet(
        options =
          StorageFacetOptions(
            column,
            sessionUuidProvider = sessionUuidProvider,
            // Storage edits are device mutations: they allocate the pane's device and carry the
            // desktop session (#10977).
            inputAllocation = inputAllocation,
          ),
      )
    // Network reads per-device via the getNetworkGraph MCP tool call (deviceId is an argument),
    // not the broadcast observation stream, so panes don't cross-contaminate.
    Tool.Network -> NetworkFacet(column)
    Tool.Performance -> PerformanceFacet(column, sessionUuidProvider = sessionUuidProvider)
    Tool.Failures -> FailuresFacet(column, sessionUuidProvider = sessionUuidProvider)
    // Navigation is app-scoped (#4837 Phase C): the facet resolves the pane device's foreground app
    // from the stream, then pulls that app's persisted graph by appId — so same-app panes share the
    // graph and a foreign broadcast can't overwrite a pane (the #4838 contamination).
    Tool.Navigation ->
      NavigationFacet(
        column = column,
        options =
          NavigationFacetOptions(
            sessionUuidProvider = sessionUuidProvider,
          ),
      )
    // Test reads the per-device test-runs daemon resource (automobile:test-runs?deviceId=<id>,
    // #4715 / #5017), scoped to the pane device so panes don't cross-contaminate (#5019).
    Tool.Test -> TestFacet(column)
  }
}
