package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryMultiplexer
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test

/** The host's status dot is fed by the stream hub and the diagnostic roll-up, not a stub. */
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
class WorkspaceStatusStateTest {
  private val pixel =
    DeviceColumn("emulator-5554", "Pixel", Platform.Android, deviceSessionUuid = "uuid-a")

  @Test
  fun `status follows the hub's device streams and failing checks`() = runComposeUiTest {
    val telemetry = FakeTelemetryMultiplexer()
    val hub =
      SharedDaemonStreamHub(
        telemetry = telemetry,
        scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher()),
      )
    val failingChecks = MutableStateFlow(0)
    val state = mutableStateOf<WorkspaceUiState>(WorkspaceUiState.Empty)
    var result: WorkspaceStatusResult? = null
    setContent {
      result =
        rememberWorkspaceStatus(
          daemon = ConnectionState.Connected(),
          workspaceState = state.value,
          hub = hub,
          failingChecks = failingChecks,
        )
    }
    try {
      waitForIdle()
      assertEquals(WorkspaceStatusResult(WorkspaceStatus.Green, null), result)

      // A pane with no open stream does not count against the status.
      runOnIdle { state.value = WorkspaceUiState.Content(listOf(pixel), pixel.deviceId) }
      waitForIdle()
      assertEquals(WorkspaceStatus.Green, result?.status)

      // A facet's stream for that pane drops: the dot turns yellow for it.
      val lease = hub.subscribeTelemetry(DeviceStreamKey(pixel.deviceId, "uuid-a")) {}
      runOnIdle {
        telemetry.subscriptions.single().setState(ConnectionState.Error("socket closed"))
      }
      waitUntil { result?.detail == "1 device offline" }

      runOnIdle { telemetry.subscriptions.single().setState(ConnectionState.Connected()) }
      waitUntil { result?.status == WorkspaceStatus.Green }

      runOnIdle { failingChecks.value = 2 }
      waitUntil { result?.detail == "2 diagnostic checks failing" }
      lease.close()
    } finally {
      hub.close()
    }
  }
}
