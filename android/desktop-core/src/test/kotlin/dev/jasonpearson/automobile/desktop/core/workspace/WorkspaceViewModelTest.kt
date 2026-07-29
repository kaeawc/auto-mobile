package dev.jasonpearson.automobile.desktop.core.workspace

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceViewModelTest {

  private val testDispatcher = UnconfinedTestDispatcher()
  private val testScope = TestScope(testDispatcher)

  private fun column(id: String, platform: Platform = Platform.Android) =
    DeviceColumn(deviceId = id, name = "Device $id", platform = platform)

  @Test
  fun `initial state is Empty`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    assertTrue(vm.state.value is WorkspaceUiState.Empty)
  }

  @Test
  fun `observing a device transitions Empty to Content and focuses it`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    val state = vm.state.value
    assertTrue("Expected Content but was $state", state is WorkspaceUiState.Content)
    state as WorkspaceUiState.Content
    assertEquals(listOf("a"), state.columns.map { it.deviceId })
    assertEquals("a", state.focusedDeviceId)
  }

  @Test
  fun `observing a second device appends a column and focuses it`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
    val state = vm.state.value as WorkspaceUiState.Content
    assertEquals(listOf("a", "b"), state.columns.map { it.deviceId })
    assertEquals("b", state.focusedDeviceId)
  }

  @Test
  fun `observing an already-observed device does not duplicate it but refocuses`() =
    testScope.runTest {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      val state = vm.state.value as WorkspaceUiState.Content
      assertEquals(listOf("a", "b"), state.columns.map { it.deviceId })
      assertEquals("a", state.focusedDeviceId)
    }

  @Test
  fun `closing a column removes it and refocuses when the focused one closes`() =
    testScope.runTest {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
      vm.onAction(WorkspaceAction.CloseDevice("b"))
      val state = vm.state.value as WorkspaceUiState.Content
      assertEquals(listOf("a"), state.columns.map { it.deviceId })
      assertEquals("a", state.focusedDeviceId)
    }

  @Test
  fun `closing the last column returns to Empty`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.CloseDevice("a"))
    assertTrue(vm.state.value is WorkspaceUiState.Empty)
  }

  @Test
  fun `closing an unfocused column keeps the current focus`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
    vm.onAction(WorkspaceAction.FocusDevice("a"))
    vm.onAction(WorkspaceAction.CloseDevice("b"))
    val state = vm.state.value as WorkspaceUiState.Content
    assertEquals("a", state.focusedDeviceId)
  }

  @Test
  fun `setMode toggleShrink and selectTool mutate only the target column`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
    vm.onAction(WorkspaceAction.SetMode("a", InteractionMode.Inspect))
    vm.onAction(WorkspaceAction.ToggleShrink("a"))
    vm.onAction(WorkspaceAction.SelectTool("a", Tool.Logs))
    val state = vm.state.value as WorkspaceUiState.Content
    val a = state.columns.first { it.deviceId == "a" }
    val b = state.columns.first { it.deviceId == "b" }
    assertEquals(InteractionMode.Inspect, a.mode)
    assertTrue(a.shrunk)
    assertEquals(Tool.Logs, a.activeTool)
    assertEquals(InteractionMode.Input, b.mode)
    assertTrue(!b.shrunk)
    assertNull(b.activeTool)
  }
}
