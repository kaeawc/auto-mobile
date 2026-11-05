package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Device epoch lifecycle reaches the workspace through one lifecycle stream per observed column
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

    fun streamFor(epoch: String): FakeObservationStream = streams.single {
      it.lastConnectedDeviceSessionUuid == epoch
    }

    fun close() = scope.cancel()
  }

  private fun ComposeUiTest.mount(h: Harness) {
    setContent {
      val state by h.vm.state.collectAsState()
      WorkspaceShellDeviceLifecycle(
        state = state,
        options =
          WorkspaceShellOptions(
            onOpenPicker = {},
            onDeviceSessionSuperseded = h.forwarder::onSuperseded,
            onDeviceSessionEnded = h.forwarder::onEnded,
            lifecycleStreamFactory = { FakeObservationStream().also { h.streams.add(it) } },
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
      assertEquals(2, h.streams.size)
      assertEquals(phoneB.deviceId, h.streamFor("epoch-b").lastConnectedDeviceId)

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
      // The ended column releases its stream; the live one keeps its own.
      assertEquals(1, h.streamFor("epoch-b").disconnectCallCount)
      assertEquals(0, h.streamFor("epoch-a").disconnectCallCount)
      assertEquals(2, h.streams.size)
      h.close()
    }

  @Test
  fun `a superseded epoch is dispatched once and the column moves to a stream on its successor`() =
    runComposeUiTest {
      val h = Harness()
      h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA))
      mount(h)

      val superseded =
        DeviceStreamEvent.DeviceSessionSuperseded(phoneA.deviceId, "epoch-a", "epoch-a2", 1L)
      runOnIdle { assertTrue(h.streamFor("epoch-a").emitDeviceEvent(superseded)) }
      waitForIdle()

      assertEquals(
        listOf(
          WorkspaceAction.EndDeviceSession(
            deviceId = phoneA.deviceId,
            retiredUuid = "epoch-a",
            successorUuid = "epoch-a2",
          ),
        ),
        h.actions.toList(),
      )
      assertEquals("epoch-a2", h.columns().single().deviceSessionUuid)
      assertEquals(1, h.streamFor("epoch-a").disconnectCallCount)
      assertEquals(1, h.streamFor("epoch-a2").connectCallCount)
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
  fun `a host with no lifecycle stream factory opens no lifecycle stream`() = runComposeUiTest {
    val h = Harness()
    h.vm.onAction(WorkspaceAction.ObserveDevice(phoneB))
    setContent {
      val state by h.vm.state.collectAsState()
      WorkspaceShellDeviceLifecycle(state, WorkspaceShellOptions(onOpenPicker = {}))
    }
    waitForIdle()
    assertTrue(h.streams.isEmpty())
    h.close()
  }

  @Test
  fun `only a column observing an epoch opens a lifecycle stream`() = runComposeUiTest {
    val h = Harness()
    h.vm.onAction(WorkspaceAction.ObserveDevice(phoneA.copy(deviceSessionUuid = null)))
    mount(h)

    assertTrue(h.streams.isEmpty())
    h.close()
  }
}
