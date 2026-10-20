package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.CoalescingRecoveryLauncher
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionState
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import dev.jasonpearson.automobile.desktop.core.workspace.DesktopOverlayState
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceSessionSupersededForwarder
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerUiState
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import kotlinx.coroutines.CoroutineScope

internal class DesktopAppUiState(settings: SettingsProvider) {
  var showUpdateDetails by mutableStateOf(false)
  var pickerOpen by mutableStateOf(false)
  var paletteOpen by mutableStateOf(false)
  var overlayState by mutableStateOf(DesktopOverlayState.None)
  val showSettings
    get() = overlayState == DesktopOverlayState.Settings

  val showAbout
    get() = overlayState == DesktopOverlayState.About

  var captureRequest by mutableStateOf<Pair<String, Int>?>(null)
  var showOnboarding by mutableStateOf(!settings.hasSeenOnboarding)
}

internal data class AppDaemonSession(
  val state: DesktopDaemonSessionState,
  val panes: MutableState<List<DesktopDaemonSessionBinding>>,
  val afterRecovery: MutableState<suspend () -> Boolean>,
)

internal data class AppInputServices(
  val desktopInputClient: AutoMobileClient,
  val workspaceControlClientProvider: () -> AutoMobileClient?,
  val paneSessionUuidProvider: () -> String?,
  val reportHeldElsewhere: (String) -> Unit,
)

internal data class AppWorkspaceServices(
  val workspaceViewModel: WorkspaceViewModel,
  val supersededForwarder: DeviceSessionSupersededForwarder,
)

internal data class AppPickerServices(
  val resourceClient: DaemonMcpResourceClient,
  val pickerViewModel: DevicePickerViewModel,
)

internal data class DesktopAppRuntime(
  val graph: AutoMobileGraphProvider,
  val settings: SettingsProvider,
  val scope: CoroutineScope,
  val session: AppDaemonSession,
  val input: AppInputServices,
  val workspace: AppWorkspaceServices,
  val picker: AppPickerServices,
  val recoveryLauncher: CoalescingRecoveryLauncher,
) {
  val desktopSessionState
    get() = session.state

  val desktopDaemonSession
    get() = session.state.session

  val desktopSessionPanes
    get() = session.panes

  val inputAllocation
    get() = session.state.inputAllocation

  val paneSessionUuidProvider
    get() = input.paneSessionUuidProvider

  val reportHeldElsewhere
    get() = input.reportHeldElsewhere

  val workspaceControlClientProvider
    get() = input.workspaceControlClientProvider

  val workspaceViewModel
    get() = workspace.workspaceViewModel

  val supersededForwarder
    get() = workspace.supersededForwarder

  val resourceClient
    get() = picker.resourceClient

  val pickerViewModel
    get() = picker.pickerViewModel

  val updateController
    get() = graph.updateController
}

internal data class DesktopAppPresentation(
  val runtime: DesktopAppRuntime,
  private val workspaceStateHolder: State<WorkspaceUiState>,
  private val pickerStateHolder: State<DevicePickerUiState>,
  private val bootstrapStateHolder: State<DaemonBootstrapState>,
  private val recoveringDaemonHolder: State<Boolean>,
  private val updateStatusHolder: State<UpdateStatus>,
  val daemonConnectionState: ConnectionState,
) {
  val workspaceState
    get() = workspaceStateHolder.value

  val pickerState
    get() = pickerStateHolder.value

  val bootstrapState
    get() = bootstrapStateHolder.value

  val recoveringDaemon
    get() = recoveringDaemonHolder.value

  val updateStatus
    get() = updateStatusHolder.value

  val graph
    get() = runtime.graph

  val settings
    get() = runtime.settings

  val scope
    get() = runtime.scope

  val desktopSessionState
    get() = runtime.desktopSessionState

  val desktopDaemonSession
    get() = runtime.desktopDaemonSession

  val desktopSessionPanes
    get() = runtime.desktopSessionPanes

  val inputAllocation
    get() = runtime.inputAllocation

  val paneSessionUuidProvider
    get() = runtime.paneSessionUuidProvider

  val reportHeldElsewhere
    get() = runtime.reportHeldElsewhere

  val workspaceControlClientProvider
    get() = runtime.workspaceControlClientProvider

  val workspaceViewModel
    get() = runtime.workspaceViewModel

  val supersededForwarder
    get() = runtime.supersededForwarder

  val resourceClient
    get() = runtime.resourceClient

  val pickerViewModel
    get() = runtime.pickerViewModel

  val updateController
    get() = runtime.updateController

  val recoveryLauncher
    get() = runtime.recoveryLauncher
}
