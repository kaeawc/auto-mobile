package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceSessionEndedTest {
  private val event = DeviceStreamEvent.DeviceSessionEnded("emulator-5554", "retired", 123L)

  private fun column(sessionUuid: String?, deviceId: String = event.deviceId) =
    DeviceColumn(
      deviceId = deviceId,
      name = "Emulator",
      platform = Platform.Android,
      deviceSessionUuid = sessionUuid,
    )

  private fun WorkspaceViewModel.columns() = (state.value as WorkspaceUiState.Content).columns

  private fun forwarder(vm: WorkspaceViewModel, actions: MutableList<WorkspaceAction>) =
    DeviceSessionSupersededForwarder(
      columns = { (vm.state.value as? WorkspaceUiState.Content)?.columns.orEmpty() },
      dispatch = {
        actions += it
        vm.onAction(it)
      },
    )

  @Test
  fun `ending the observed epoch drops it and marks the column ended`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))

      vm.onAction(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))

      val ended = vm.columns().single()
      assertTrue(ended.sessionEnded)
      assertNull(ended.deviceSessionUuid)
    }

  @Test
  fun `ending a different epoch leaves the column untouched`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column("current")))
      val before = vm.state.value

      vm.onAction(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))

      assertEquals(before, vm.state.value)
    }

  @Test
  fun `ending one device's epoch leaves other columns untouched`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column("other-epoch", deviceId = "other-device")))
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))

      vm.onAction(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))

      val (other, ended) = vm.columns()
      assertFalse(other.sessionEnded)
      assertEquals("other-epoch", other.deviceSessionUuid)
      assertTrue(ended.sessionEnded)
    }

  @Test
  fun `a fresh epoch for an ended column revives it`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))
      vm.onAction(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))

      vm.onAction(WorkspaceAction.RefreshDeviceSessionUuids(mapOf(event.deviceId to "successor")))

      val revived = vm.columns().single()
      assertFalse(revived.sessionEnded)
      assertEquals("successor", revived.deviceSessionUuid)
    }

  @Test
  fun `observing the device again revives an ended column`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))
      vm.onAction(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))

      vm.onAction(WorkspaceAction.ObserveDevice(column("successor")))

      val revived = vm.columns().single()
      assertFalse(revived.sessionEnded)
      assertEquals("successor", revived.deviceSessionUuid)
      // A returning device is a new epoch: the pane's remembered state is dropped.
      assertEquals(1, revived.epochGeneration)
    }

  @Test
  fun `forwarder dispatches an end only for the observed epoch`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      val forwarder = forwarder(vm, actions)
      vm.onAction(WorkspaceAction.ObserveDevice(column("current")))

      forwarder.onEnded(event)
      assertTrue(actions.isEmpty())

      vm.onAction(WorkspaceAction.RefreshDeviceSessionUuids(mapOf(event.deviceId to "retired")))
      forwarder.onEnded(event)
      // A duplicate frame finds the epoch already dropped and dispatches nothing more.
      forwarder.onEnded(event)

      assertEquals(
        listOf(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid)),
        actions,
      )
      assertTrue(vm.columns().single().sessionEnded)
    }

  @Test
  fun `forwarder ignores a device absent from the workspace`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()

      forwarder(vm, actions).onEnded(event)

      assertTrue(actions.isEmpty())
      assertEquals(WorkspaceUiState.Empty, vm.state.value)
    }

  @Test
  fun `an ended column cannot be one side of a compare`() {
    val content =
      WorkspaceUiState.Content(
        listOf(column(null).copy(sessionEnded = true), column("live", deviceId = "other")),
        focusedDeviceId = event.deviceId,
      )

    assertNull(compareColumns(content))
  }
}
