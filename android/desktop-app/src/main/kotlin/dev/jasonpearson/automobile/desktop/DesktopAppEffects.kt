package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.BOOTED_DEVICES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.DEVICE_LOCK_STATES_RESOURCE_URI
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceAction
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceEffect
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.parseBootedLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.parseDeviceLockStates
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerAction
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerEffect
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerUiState
import dev.jasonpearson.automobile.desktop.core.workspace.wireName
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException

private val LOG = LoggerFactory.getLogger("AutoMobileDesktopApp")

@Composable
internal fun DesktopMenuEffects(
  presentation: DesktopAppPresentation,
  ui: DesktopAppUiState,
  menuBarActions: MenuBarActions,
  openPaletteRequest: Int,
) {
  with(presentation) {
    with(ui) {
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
      val launchSurfaceVisible = showOnboarding || pickerOpen
      val modalVisible = showSettings || showAbout
      val canOpenPalette =
        !launchSurfaceVisible && !modalVisible && workspaceState is WorkspaceUiState.Content
      LaunchedEffect(menuBarActions.showCommandPalette) {
        if (menuBarActions.showCommandPalette) {
          if (canOpenPalette) {
            paletteOpen = true
          }
          menuBarActions.showCommandPalette = false
        }
      }
      DesktopCaptureMenuEffect(presentation, ui, menuBarActions)

      val paneBindings =
        (workspaceState as? WorkspaceUiState.Content)?.columns.orEmpty().map {
          DesktopDaemonSessionBinding(it.deviceId, it.platform.wireName())
        }
      SideEffect { desktopSessionPanes.value = paneBindings }

      // Window-level ⌘K/Ctrl+K (Main.kt) bumps openPaletteRequest; open the palette in response,
      // but
      // only while the workspace is showing — onboarding and the device grid (shown while nothing
      // is
      // observed, or when explicitly opened) own the screen and have no palette. The `> 0` guard
      // skips
      // the initial composition (the counter starts at 0).
      LaunchedEffect(openPaletteRequest) {
        if (openPaletteRequest > 0 && canOpenPalette) {
          paletteOpen = true
        }
      }
    }
  }
}

@Composable
internal fun DesktopWorkspaceEffects(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
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

      LaunchedEffect(pickerViewModel) {
        pickerViewModel.effect.collect { effect ->
          if (effect is DevicePickerEffect.Observe) {
            effect.columns.forEach {
              workspaceViewModel.onAction(WorkspaceAction.ObserveDevice(it))
            }
            pickerOpen = false
          }
        }
      }
      // Returning to the home grid (the last workspace column closed) refreshes the picker so it
      // reflects
      // devices started/killed externally during the workspace session — otherwise the picker only
      // loads
      // on init and via OpenPicker, so a stale grid could dispatch the wrong observe/boot (Codex
      // P2).
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
    }
  }
}

@Composable
internal fun DesktopLockStateEffect(presentation: DesktopAppPresentation) {
  with(presentation) {
    LaunchedEffect(workspaceViewModel, resourceClient) {
      while (true) {
        val hasColumns =
          (workspaceViewModel.state.value as? WorkspaceUiState.Content)?.columns?.isNotEmpty() ==
            true
        if (hasColumns) {
          val states =
            try {
              when (
                val result = readDesktopResource(resourceClient, DEVICE_LOCK_STATES_RESOURCE_URI)
              ) {
                is ResourceReadResult.Success -> parseDeviceLockStates(result.content)
                // An older daemon (reached over a non-reconciling HTTP/STDIO transport) doesn't
                // expose the lightweight lockStates resource; fall back to the full booted-devices
                // resource, which also carries each device's lock flag, so the Unlock control keeps
                // tracking reality instead of going permanently stale.
                is ResourceReadResult.Error ->
                  when (
                    val booted = readDesktopResource(resourceClient, BOOTED_DEVICES_RESOURCE_URI)
                  ) {
                    is ResourceReadResult.Success -> parseBootedLockStates(booted.content)
                    is ResourceReadResult.Error -> emptyMap()
                  }
              }
            } catch (cancellation: CancellationException) {
              throw cancellation
            } catch (error: McpConnectionException) {
              LOG.warn("Lock-state poll failed: ${error.message}", error)
              emptyMap()
            } catch (error: IOException) {
              LOG.warn("Lock-state poll failed: ${error.message}", error)
              emptyMap()
            } catch (error: SerializationException) {
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
  }
}

@Composable
internal fun DesktopGridEffects(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
      val gridVisible = !showOnboarding && (pickerOpen || workspaceState is WorkspaceUiState.Empty)
      LaunchedEffect(pickerViewModel, gridVisible) {
        if (!gridVisible) return@LaunchedEffect
        while (true) {
          delay(GRID_REFRESH_POLL_MS)
          pickerViewModel.onAction(DevicePickerAction.SilentRefresh)
        }
      }
      // A failed first load is otherwise a dead end (SilentRefresh only polls from Content): retry
      // it
      // automatically ONCE per disconnected -> connected transition of the daemon health poll — the
      // "daemon was down, now it's back" recovery. Latching on the transition (not on the Error
      // state)
      // means a read that keeps failing WHILE the daemon stays connected (e.g. a malformed payload)
      // is
      // not retried in a Loading/Error flash loop every few seconds; that persistent case stays on
      // the
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
    }
  }
}

internal suspend fun readDesktopResource(
  resourceClient: DaemonMcpResourceClient,
  uri: String,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
): ResourceReadResult = withContext(ioDispatcher) { resourceClient.readResource(uri) }

@Composable
private fun DesktopCaptureMenuEffect(
  presentation: DesktopAppPresentation,
  ui: DesktopAppUiState,
  menuBarActions: MenuBarActions,
) {
  with(presentation) {
    with(ui) {
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
    }
  }
}
