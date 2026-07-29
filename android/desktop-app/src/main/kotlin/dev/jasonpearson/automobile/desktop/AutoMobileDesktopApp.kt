package dev.jasonpearson.automobile.desktop

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
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceEffect
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShell
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceViewModel
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePicker
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerAction
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerEffect
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerViewModel
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme

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
  @Suppress("UNUSED_PARAMETER") menuBarActions: MenuBarActions = remember { MenuBarActions() }
) {
  val graph = LocalAutoMobileGraph.current
  val settings = remember(graph) { ObservableSettingsProvider(graph.settingsProvider) }
  val scope = rememberCoroutineScope()
  val workspaceViewModel = remember(scope) { WorkspaceViewModel(scope) }
  val workspaceState by workspaceViewModel.state.collectAsState()

  val resourceClient = remember(graph) { DaemonMcpResourceClient(graph.autoMobileClient) }
  val pickerViewModel =
    remember(scope, resourceClient) { DevicePickerViewModel(resourceClient, scope) }
  val pickerState by pickerViewModel.state.collectAsState()
  var pickerOpen by remember { mutableStateOf(false) }

  // OpenPicker (from the empty state or the Devices launcher) shows the picker; observing selected
  // devices turns them into workspace columns.
  LaunchedEffect(workspaceViewModel) {
    workspaceViewModel.effect.collect { effect ->
      if (effect is WorkspaceEffect.OpenPicker) {
        pickerViewModel.onAction(DevicePickerAction.Refresh)
        pickerOpen = true
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
      if (pickerOpen) {
        DevicePicker(
          state = pickerState,
          onAction = pickerViewModel::onAction,
          onClose = { pickerOpen = false },
        )
      } else {
        WorkspaceShell(
          state = workspaceState,
          onAction = workspaceViewModel::onAction,
          onOpenPicker = workspaceViewModel::openPicker,
        )
      }
    }
  }
}
