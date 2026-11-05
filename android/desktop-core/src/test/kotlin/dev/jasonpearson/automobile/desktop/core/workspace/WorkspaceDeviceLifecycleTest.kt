package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationHubConfig
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationReconnectPolicy
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Device epoch lifecycle reaches the workspace through one lifecycle lease per observed column
 * (#17061), with no facet open and no pane focused or controllable.
 */
@OptIn(ExperimentalTestApi::class, kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WorkspaceDeviceLifecycleTest {
  private val phoneA = column("emulator-5554", "epoch-a")
  private val phoneB = column("emulator-5556", "epoch-b")

  private fun column(deviceId: String, epoch: String) =
    DeviceColumn(
      deviceId = deviceId,
      name = deviceId,
      platform = Platform.Android,
      deviceSessionUuid = epoch,
    )

  private class Harness {
    val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())
    val streams = CopyOnWriteArrayList<FakeObservationStream>()
    val hub =
      SharedDaemonStreamHub(
        telemetryClientFactory = { FakeTelemetryPushClient() },
        scope = scope,
        observation =
          ObservationHubConfig(
            streamFactory = { FakeObservationStream().also { streams.add(it) } },
            reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
          ),
      )
    val vm = WorkspaceViewModel(scope)
    val actions = CopyOnWriteArrayList<WorkspaceAction>()
    val forwarder =
      DeviceSessionSupersededForwarder(
        columns = { columns() },
        dispatch = {
          actions += it
          vm.onAction(it)
        },
      )

    fun columns() = (vm.state.value as? WorkspaceUiState.Content)?.columns.orEmpty()

    fun streamFor(epoch: String) = streams.single { it.lastConnectedDeviceSessionUuid == epoch }

    fun close() {
      hub.close()
      scope.cancel()
    }
  }

  private fun androidx.compose.ui.test.ComposeUiTest.mount(h: Harness) {
    setContent {
      val state by h.vm.state.collectAsState()
      WorkspaceDeviceLifecycle(
        columns = (state as? WorkspaceUiState.Content)?.columns.orEmpty(),
        lifecycleStreamFor = {
          h.hub.lifecycleStream(DeviceStreamKey(it.deviceId, it.deviceSessionUuid))
        },
        handlers =
          WorkspaceDeviceLifecycleHandlers(
            onSuperseded = h.forwarder::onSuperseded,
            onEnded = h.forwarder::onEnded,
          ),
      )
    }
    waitForIdle()
  }

  @Test
  fun `an unfocused pane with no facets is marked ended when its device leaves`() =
    runComposeUiTest {
      val h = Harness()
      h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA))
      h.vm.onAction(WorkspaceAction.ObserveDevice(phoneB))
      mount(h)
      assertEquals(
        mapOf(
          DeviceStreamKey(phoneA.deviceId, "epoch-a") to 1,
          DeviceStreamKey(phoneB.deviceId, "epoch-b") to 1,
        ),
        h.hub.observationSubscriptions.value,
      )

      val ended = DeviceStreamEvent.DeviceSessionEnded(phoneB.deviceId, "epoch-b", 1L)
      runOnIdle { assertTrue(h.streamFor("epoch-b").emitDeviceEvent(ended)) }
      waitForIdle()

      assertEquals(
        listOf(WorkspaceAction.EndDeviceSession(phoneB.deviceId, "epoch-b")),
        h.actions.toList(),
      )
      val (a, b) = h.columns()
      assertFalse(a.sessionEnded)
      assertTrue(b.sessionEnded)
      assertNull(b.deviceSessionUuid)
      // The ended column releases its lease; the live one keeps its own.
      assertEquals(
        mapOf(DeviceStreamKey(phoneA.deviceId, "epoch-a") to 1),
        h.hub.observationSubscriptions.value,
      )
      assertEquals(1, h.streamFor("epoch-b").disconnectCallCount)
      h.close()
    }

  @Test
  fun `a superseded epoch is dispatched once and the column moves to a lease on its successor`() =
    runComposeUiTest {
      val h = Harness()
      h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA))
      mount(h)
      // A facet on the same epoch shares the connection but no longer forwards lifecycle itself.
      h.hub.observationStream(DeviceStreamKey(phoneA.deviceId, "epoch-a")).connect()
      assertEquals(1, h.streams.size)

      val superseded =
        DeviceStreamEvent.DeviceSessionSuperseded(phoneA.deviceId, "epoch-a", "epoch-a2", 1L)
      runOnIdle { assertTrue(h.streamFor("epoch-a").emitDeviceEvent(superseded)) }
      waitForIdle()

      assertEquals(
        listOf(WorkspaceAction.RefreshDeviceSessionUuids(mapOf(phoneA.deviceId to "epoch-a2"))),
        h.actions.toList(),
      )
      assertEquals("epoch-a2", h.columns().single().deviceSessionUuid)
      assertEquals(1, h.streamFor("epoch-a2").connectCallCount)
      assertEquals(
        mapOf(
          DeviceStreamKey(phoneA.deviceId, "epoch-a") to 1,
          DeviceStreamKey(phoneA.deviceId, "epoch-a2") to 1,
        ),
        h.hub.observationSubscriptions.value,
      )
      h.close()
    }

  @Test
  fun `events for another device on a column's stream are not forwarded`() = runComposeUiTest {
    val h = Harness()
    h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA))
    mount(h)

    val stray = DeviceStreamEvent.DeviceSessionEnded(phoneB.deviceId, "epoch-a", 1L)
    runOnIdle { assertTrue(h.streamFor("epoch-a").emitDeviceEvent(stray)) }
    waitForIdle()

    assertTrue(h.actions.isEmpty())
    assertFalse(h.columns().single().sessionEnded)
    h.close()
  }

  @Test
  fun `a column with no epoch holds no lifecycle lease`() = runComposeUiTest {
    val h = Harness()
    h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA.copy(deviceSessionUuid = null)))
    mount(h)

    assertTrue(h.streams.isEmpty())
    assertTrue(h.hub.observationSubscriptions.value.isEmpty())
    h.close()
  }
}
