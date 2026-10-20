package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.layout.DeviceBindErrorNotice
import dev.jasonpearson.automobile.desktop.core.layout.DeviceIdleReleasedNotice
import dev.jasonpearson.automobile.desktop.core.layout.DeviceViewingNotice
import dev.jasonpearson.automobile.desktop.core.settings.SettingsPanel
import dev.jasonpearson.automobile.desktop.core.shell.AboutDialog
import dev.jasonpearson.automobile.desktop.core.shell.FloatingUpdateAffordance
import dev.jasonpearson.automobile.desktop.core.shell.UpdateDetailsContent
import dev.jasonpearson.automobile.desktop.core.shell.openReleaseNotesInBrowser
import dev.jasonpearson.automobile.desktop.core.update.UpdateStatus
import dev.jasonpearson.automobile.desktop.core.workspace.CommandPalette
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceStreamOptions
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceStreamView
import dev.jasonpearson.automobile.desktop.core.workspace.LayoutFacet
import dev.jasonpearson.automobile.desktop.core.workspace.OnboardingScreen
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShell
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceShellOptions
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import dev.jasonpearson.automobile.desktop.core.workspace.buildWorkspaceCommands
import dev.jasonpearson.automobile.desktop.core.workspace.deriveWorkspaceStatus
import dev.jasonpearson.automobile.desktop.core.workspace.isolatedBehindOverlay
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePicker
import dev.jasonpearson.automobile.desktop.core.workspace.picker.DevicePickerOptions
import dev.jasonpearson.automobile.desktop.core.workspace.rememberWorkspaceDeviceControl
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme
import kotlinx.coroutines.launch

@Composable
internal fun DesktopAppSurface(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
      AutoMobileTheme(themeMode = settings.themeMode) {
        Surface(
          modifier = Modifier.fillMaxSize(),
          color = MaterialTheme.colorScheme.background,
        ) {
          // Device-tab workspace is the desktop app root (replaces ThreePaneShell).
          // AutoMobileContent
          // is retained and still used by the IDE plugin; dashboards return as workspace facets in
          // follow-up PRs.
          //
          // The launch surfaces (onboarding + device picker) have no top bar to host the "update
          // ready"
          // pill, so a user who never observes a device would never see the affordance even though
          // the
          // startup check already ran (#5271). The workspace keeps its integrated top-bar pill;
          // these
          // surfaces get a shared floating affordance instead, hosted above the surface switch so
          // it is
          // reachable from either one. It self-hides unless updateStatus is UpdateAvailable.
          val onLaunchSurface =
            showOnboarding || pickerOpen || workspaceState is WorkspaceUiState.Empty
          Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().isolatedBehindOverlay(showSettings || showAbout)) {
              DesktopLaunchSurface(presentation, ui)

              // Shared floating "update ready" affordance for the launch surfaces (#5271). Clicking
              // it
              // opens the same UpdateDetailsContent the workspace pill uses, wired to
              // apply-in-place
              // only
              // when the packaging supports it (canApplyUpdate) — the GitHub-Releases path leaves
              // the
              // install action disabled until the apply item (#5226) lands.
              DesktopLaunchUpdate(presentation, onLaunchSurface)
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
  }
}

@Composable
internal fun androidx.compose.foundation.layout.BoxScope.DesktopStreamNotice(
  presentation: DesktopAppPresentation,
  column: DeviceColumn,
  onTakeControl: () -> Unit,
) {
  with(presentation) {
    val heldElsewhere = desktopSessionState.heldElsewhereDeviceId == column.deviceId
    val idleReleased = desktopSessionState.idleReleasedDeviceId == column.deviceId
    val bindError =
      desktopSessionState.bindErrorMessage?.takeIf {
        desktopSessionState.bindErrorDeviceId == column.deviceId
      }
    if (heldElsewhere) {
      DeviceViewingNotice(
        onTakeControl = onTakeControl,
        modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
      )
    } else if (idleReleased) {
      DeviceIdleReleasedNotice(
        reason = desktopSessionState.releaseReason,
        onTakeControl = onTakeControl,
        modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
      )
    } else if (bindError != null) {
      DeviceBindErrorNotice(
        message = bindError,
        onRetry = onTakeControl,
        modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
      )
    }
  }
}

@Composable
internal fun DesktopStreamContent(
  presentation: DesktopAppPresentation,
  column: DeviceColumn,
  streamingEnabled: Boolean,
) {
  with(presentation) {

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
    val focused = (workspaceState as? WorkspaceUiState.Content)?.focusedDeviceId == column.deviceId
    val controlActive =
      graph.autoMobileClient.transportName == "Unix Socket" && focused && !heldElsewhere
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
        dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceDeviceControlOptions(
          column = column,
          clientProvider = columnControlClientProvider,
          enabled = controlActive,
          sessionUuidProvider = paneSessionUuidProvider,
          onDeviceHeldElsewhere = reportHeldElsewhere,
        ),
      )
    Box {
      DeviceStreamView(
        options =
          DeviceStreamOptions(
            column = column,
            sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
            enableDeviceControl = controlActive,
            control = control,
            // Wires the per-pane quality overlay (manual Low/Medium/High + live FPS +
            // auto-adjust) and persists the choice across sessions.
            settings = settings,
            streamingEnabled = streamingEnabled,
          ),
      )
      DesktopStreamNotice(presentation, column, takeControl)
    }
  }
}

@Composable
internal fun DesktopUpdatePopup(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
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
}

@Composable
internal fun DesktopWorkspaceShell(
  presentation: DesktopAppPresentation,
  ui: DesktopAppUiState,
  streamingEnabled: Boolean,
) {
  with(presentation) {
    with(ui) {
      val workspaceStatus =
        remember(daemonConnectionState) {
          deriveWorkspaceStatus(daemon = daemonConnectionState, devices = emptyList())
        }

      WorkspaceShell(
        state = workspaceState,
        onAction = workspaceViewModel::onAction,
        // The ⌘K command palette is a sibling overlay hosted here (not inside the shell),
        // so isolate the whole workspace behind it — matching how the shell isolates its
        // own scrimmed panels — to keep the palette modal to keyboard/a11y focus (#4846).
        modifier = Modifier.isolatedBehindOverlay(paletteOpen),
        options =
          WorkspaceShellOptions(
            onDeviceSessionSuperseded = supersededForwarder::onSuperseded,
            onOpenPicker = workspaceViewModel::openPicker,
            onOpenPalette = { paletteOpen = true },
            externalCaptureRequest = captureRequest,
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
                inputAllocation = inputAllocation,
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
                dev.jasonpearson.automobile.desktop.core.workspace.LayoutFacetOptions(
                  column,
                  sessionUuidProvider = desktopDaemonSession?.sessionUuidProvider ?: { null },
                  streamingEnabled = streamingEnabled,
                ),
              )
            },
            // Live device mirror in each pane's stream area, fed by the daemon's video-stream
            // relay. The pane authenticates with the workspace daemon session (#4977), which
            // the daemon admits as a viewer whether or not it holds the device (#10698);
            // when no session is available (non-Unix daemon, or registration failed) the
            // provider yields null and the pane shows the auth refusal, with
            // AUTOMOBILE_DAEMON_STREAM_AUTH=0 as the operator escape hatch.
            streamContent = { column ->
              DesktopStreamContent(presentation, column, streamingEnabled)
            },
          ),
      )
    }
  }
}

@Composable
internal fun DesktopWorkspaceContent(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
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
        DesktopWorkspaceShell(presentation, ui, streamingEnabled)
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
        DesktopUpdatePopup(presentation, ui)
      }
    }
  }
}

@Composable
internal fun DesktopLaunchSurface(presentation: DesktopAppPresentation, ui: DesktopAppUiState) {
  with(presentation) {
    with(ui) {
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
            options =
              DevicePickerOptions(
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
              ),
          )
        else -> DesktopWorkspaceContent(presentation, ui)
      }
    }
  }
}

@Composable
internal fun DesktopLaunchUpdate(presentation: DesktopAppPresentation, onLaunchSurface: Boolean) {
  with(presentation) {
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
