package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.CoalescingRecoveryLauncher
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionOptions
import dev.jasonpearson.automobile.desktop.core.daemon.InputAllocatingClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.daemon.rememberDesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.rememberPaneSessionUuidProvider
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.workspace.BOOTED_DEVICES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.DaemonEmulatorControlExecutor
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceSessionSupersededForwarder
import dev.jasonpearson.automobile.desktop.core.workspace.ObservationForegroundAppResolver
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.parseBootedDeviceSessionUuids
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.RealDeviceBootController
import kotlinx.coroutines.CoroutineScope

private val LOG = LoggerFactory.getLogger("AutoMobileDesktopApp")

@Composable
internal fun rememberAppDaemonSession(
  graph: AutoMobileGraphProvider,
  windowVisible: Boolean,
): AppDaemonSession {
  val desktopSessionPanes = remember {
    mutableStateOf<List<DesktopDaemonSessionBinding>>(emptyList())
  }
  val refreshAfterDaemonRecovery = remember { mutableStateOf<suspend () -> Boolean>({ true }) }
  // Resolved once, not per recomposition: the path lookup is process-wide cached (#10238) but the
  // root must not call into it at all on the UI thread.
  val usesUnixSocket = graph.autoMobileClient.transportName == "Unix Socket"
  val desktopSocketPath =
    remember(usesUnixSocket) { if (usesUnixSocket) DaemonSocketPaths.socketPath() else null }
  val desktopSessionState =
    rememberDesktopDaemonSession(
      DesktopDaemonSessionOptions(
        desktopSocketPath,
        desktopSessionPanes,
        hostVisible = windowVisible,
        onDaemonRecovered = { refreshAfterDaemonRecovery.value() },
      ),
    )
  return AppDaemonSession(desktopSessionState, desktopSessionPanes, refreshAfterDaemonRecovery)
}

@Composable
internal fun rememberAppInput(
  graph: AutoMobileGraphProvider,
  session: AppDaemonSession,
): AppInputServices {
  val desktopSessionState = session.state
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

  val paneSessionUuidProvider = rememberPaneSessionUuidProvider(desktopSessionState)
  return AppInputServices(
    desktopInputClient,
    workspaceControlClientProvider,
    paneSessionUuidProvider,
    reportHeldElsewhere,
  )
}

@Composable
internal fun rememberAppWorkspace(
  graph: AutoMobileGraphProvider,
  scope: CoroutineScope,
  session: AppDaemonSession,
  input: AppInputServices,
): AppWorkspaceServices {
  val desktopDaemonSession = session.state.session
  val desktopInputClient = input.desktopInputClient
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
  val supersededForwarder =
    remember(workspaceViewModel) {
      DeviceSessionSupersededForwarder(
        columns = {
          (workspaceViewModel.state.value as? WorkspaceUiState.Content)?.columns.orEmpty()
        },
        dispatch = workspaceViewModel::onAction,
      )
    }

  return AppWorkspaceServices(workspaceViewModel, supersededForwarder)
}

@Composable
internal fun rememberAppPicker(
  graph: AutoMobileGraphProvider,
  scope: CoroutineScope,
  workspaceViewModel: WorkspaceViewModel,
  session: AppDaemonSession,
): AppPickerServices {
  val resourceClient = remember(graph) { DaemonMcpResourceClient(graph.autoMobileClient) }
  val refreshDesktopSessionState: suspend () -> Boolean =
    remember(resourceClient, workspaceViewModel) {
      {
        val sessionUuids = runCatching {
          readDesktopResource(resourceClient, BOOTED_DEVICES_RESOURCE_URI)
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
  SideEffect { session.afterRecovery.value = refreshDesktopSessionState }
  val bootController = remember(graph) { RealDeviceBootController(graph.autoMobileClient) }
  val pickerViewModel =
    remember(scope, resourceClient, bootController) {
      DevicePickerViewModel(resourceClient, bootController, scope)
    }

  return AppPickerServices(resourceClient, pickerViewModel)
}

@Composable
internal fun rememberDesktopRuntime(windowVisible: Boolean): DesktopAppRuntime {
  val graph = LocalAutoMobileGraph.current
  val session = rememberAppDaemonSession(graph, windowVisible)
  val settings = remember(graph) { ObservableSettingsProvider(graph.settingsProvider) }
  val scope = rememberCoroutineScope()
  val input = rememberAppInput(graph, session)
  val workspace = rememberAppWorkspace(graph, scope, session, input)
  val picker = rememberAppPicker(graph, scope, workspace.workspaceViewModel, session)
  val daemonBootstrap = graph.daemonBootstrap
  val recoveryLauncher =
    remember(scope, daemonBootstrap) {
      CoalescingRecoveryLauncher(scope = scope, recover = { daemonBootstrap.ensureReady() })
    }
  return DesktopAppRuntime(
    graph,
    settings,
    scope,
    session,
    input,
    workspace,
    picker,
    recoveryLauncher,
  )
}

@Composable
internal fun desktopPresentation(
  runtime: DesktopAppRuntime,
  daemonConnectionState: ConnectionState,
): DesktopAppPresentation {
  val workspaceState = runtime.workspaceViewModel.state.collectAsState()
  val pickerState = runtime.pickerViewModel.state.collectAsState()
  val bootstrapState = runtime.graph.daemonBootstrap.state.collectAsState()
  val recoveringDaemon = runtime.recoveryLauncher.inFlight.collectAsState()
  val updateController = runtime.updateController
  val updateStatus = updateController.status.collectAsState()
  LaunchedEffect(updateController) { updateController.checkForUpdate() }
  return DesktopAppPresentation(
    runtime,
    workspaceState,
    pickerState,
    bootstrapState,
    recoveringDaemon,
    updateStatus,
    daemonConnectionState,
  )
}
