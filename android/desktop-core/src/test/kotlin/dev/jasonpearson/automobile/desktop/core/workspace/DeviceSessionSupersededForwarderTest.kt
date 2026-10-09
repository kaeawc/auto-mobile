package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceSessionSupersededForwarderTest {
  private val event =
    DeviceStreamEvent.DeviceSessionSuperseded("emulator-5554", "retired", "successor", 123L)

  private fun column(sessionUuid: String?) =
    DeviceColumn(
      deviceId = event.deviceId,
      name = "Emulator",
      platform = Platform.Android,
      deviceSessionUuid = sessionUuid,
    )

  private fun forwarder(vm: WorkspaceViewModel, actions: MutableList<WorkspaceAction>) =
    DeviceSessionSupersededForwarder(
      columns = { (vm.state.value as? WorkspaceUiState.Content)?.columns.orEmpty() },
      dispatch = {
        actions += it
        vm.onAction(it)
      },
    )

  @Test
  fun `matching retired epoch dispatches the existing action and re-keys the live column`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      // Construct before observing the device to prove columns are read live at event time.
      val forwarder = forwarder(vm, actions)
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))

      forwarder.onSuperseded(event)

      assertEquals(
        listOf(
          WorkspaceAction.RefreshDeviceSessionUuids(mapOf(event.deviceId to event.successorUuid)),
        ),
        actions,
      )
      assertEquals(
        event.successorUuid,
        (vm.state.value as WorkspaceUiState.Content).columns.single().deviceSessionUuid,
      )
    }

  @Test
  fun `unrelated retired epoch leaves state unchanged`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      vm.onAction(WorkspaceAction.ObserveDevice(column("other-epoch")))
      val before = vm.state.value

      forwarder(vm, actions).onSuperseded(event)

      assertTrue(actions.isEmpty())
      assertEquals(before, vm.state.value)
    }

  @Test
  fun `a duplicate superseded event re-keys exactly once`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      vm.onAction(WorkspaceAction.ObserveDevice(column(event.retiredUuid)))
      val forwarder = forwarder(vm, actions)

      forwarder.onSuperseded(event)
      forwarder.onSuperseded(event)

      assertEquals(
        listOf(
          WorkspaceAction.RefreshDeviceSessionUuids(mapOf(event.deviceId to event.successorUuid)),
        ),
        actions,
      )
      assertEquals(
        event.successorUuid,
        (vm.state.value as WorkspaceUiState.Content).columns.single().deviceSessionUuid,
      )
    }

  @Test
  fun `a device absent from the workspace leaves state unchanged`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      vm.onAction(
        WorkspaceAction.ObserveDevice(column(event.retiredUuid).copy(deviceId = "other-device")),
      )
      val before = vm.state.value

      forwarder(vm, actions).onSuperseded(event)

      assertTrue(actions.isEmpty())
      assertEquals(before, vm.state.value)
    }

  @Test
  fun `a column with no epoch leaves state unchanged`() =
    runTest(UnconfinedTestDispatcher()) {
      val vm = WorkspaceViewModel(this)
      val actions = mutableListOf<WorkspaceAction>()
      vm.onAction(WorkspaceAction.ObserveDevice(column(null)))
      val before = vm.state.value

      forwarder(vm, actions).onSuperseded(event)

      assertTrue(actions.isEmpty())
      assertEquals(before, vm.state.value)
    }
}
