package dev.jasonpearson.automobile.desktop.core.workspace

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
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

  @Test
  fun `RunControl runs the control against the targeted device with its platform`() =
    testScope.runTest {
      val exec = FakeEmulatorControlExecutor()
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a", Platform.Ios)))
      vm.onAction(WorkspaceAction.RunControl("a", EmulatorControl.Snapshot))
      assertEquals(
        listOf(
          FakeEmulatorControlExecutor.Request(
            "a",
            Platform.Ios,
            EmulatorControl.Snapshot,
            Orientation.Portrait,
          )
        ),
        exec.requests,
      )
    }

  @Test
  fun `RunControl Rotate toggles the tracked orientation and passes the new value`() =
    testScope.runTest {
      val exec = FakeEmulatorControlExecutor()
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))

      vm.onAction(WorkspaceAction.RunControl("a", EmulatorControl.Rotate))
      var col = (vm.state.value as WorkspaceUiState.Content).columns.first { it.deviceId == "a" }
      assertEquals(Orientation.Landscape, col.orientation)
      assertEquals(Orientation.Landscape, exec.requests.last().orientation)

      // A second Rotate flips back to Portrait — and passes that new value on.
      vm.onAction(WorkspaceAction.RunControl("a", EmulatorControl.Rotate))
      col = (vm.state.value as WorkspaceUiState.Content).columns.first { it.deviceId == "a" }
      assertEquals(Orientation.Portrait, col.orientation)
      assertEquals(Orientation.Portrait, exec.requests.last().orientation)
    }

  @Test
  fun `RunControl swallows an executor failure without crashing the workspace`() =
    testScope.runTest {
      val exec = FakeEmulatorControlExecutor().apply { error = RuntimeException("boom") }
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      vm.onAction(WorkspaceAction.RunControl("a", EmulatorControl.Unlock))
      // The failure is caught + logged, not propagated: state stays intact.
      assertTrue(vm.state.value is WorkspaceUiState.Content)
    }

  @Test
  fun `DiffTool opens the tool on every observed column`() = testScope.runTest {
    val vm = WorkspaceViewModel(this)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.ObserveDevice(column("b")))
    vm.onAction(WorkspaceAction.SelectTool("a", Tool.Storage))
    vm.onAction(WorkspaceAction.DiffTool(Tool.Logs))
    val state = vm.state.value as WorkspaceUiState.Content
    assertTrue(
      "every column should show the diffed tool",
      state.columns.all { it.activeTool == Tool.Logs },
    )
  }

  @Test
  fun `RunControl for an unknown device runs nothing`() = testScope.runTest {
    val exec = FakeEmulatorControlExecutor()
    val vm = WorkspaceViewModel(this, exec)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.RunControl("nope", EmulatorControl.Snapshot))
    assertTrue(exec.requests.isEmpty())
  }

  @Test
  fun `PressDeviceButton invokes the executor with the button and target platform`() =
    testScope.runTest {
      val exec = FakeEmulatorControlExecutor()
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a", Platform.Android)))
      vm.onAction(WorkspaceAction.PressDeviceButton("a", DeviceButton.Home))
      assertEquals(
        listOf(FakeEmulatorControlExecutor.ButtonRequest("a", Platform.Android, DeviceButton.Home)),
        exec.buttonRequests,
      )
    }

  @Test
  fun `SetLocale invokes the executor with the locale tag and target platform`() =
    testScope.runTest {
      val exec = FakeEmulatorControlExecutor()
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a", Platform.Ios)))
      vm.onAction(WorkspaceAction.SetLocale("a", "ja-JP"))
      assertEquals(
        listOf(FakeEmulatorControlExecutor.LocaleRequest("a", Platform.Ios, "ja-JP")),
        exec.localeRequests,
      )
    }

  @Test
  fun `a later locale pick supersedes a still-resolving one on the same device`() =
    testScope.runTest {
      val gate = CompletableDeferred<Unit>()
      val exec = FakeEmulatorControlExecutor().apply { localeGate = gate }
      val vm = WorkspaceViewModel(this, exec)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      // The first pick parks while resolving the foreground app; the second must cancel it so the
      // device ends in the last-picked locale rather than whichever request happens to finish last.
      vm.onAction(WorkspaceAction.SetLocale("a", "es-ES"))
      vm.onAction(WorkspaceAction.SetLocale("a", "de-DE"))
      gate.complete(Unit)
      advanceUntilIdle()
      assertEquals(listOf("de-DE"), exec.localeRequests.map { it.locale })
    }

  @Test
  fun `PressDeviceButton and SetLocale for an unknown device run nothing`() = testScope.runTest {
    val exec = FakeEmulatorControlExecutor()
    val vm = WorkspaceViewModel(this, exec)
    vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
    vm.onAction(WorkspaceAction.PressDeviceButton("nope", DeviceButton.Back))
    vm.onAction(WorkspaceAction.SetLocale("nope", "de-DE"))
    assertTrue(exec.buttonRequests.isEmpty() && exec.localeRequests.isEmpty())
  }

  @Test
  fun `SetLockStates updates matched columns and leaves absent devices unchanged`() =
    testScope.runTest {
      val vm = WorkspaceViewModel(this)
      vm.onAction(WorkspaceAction.ObserveDevice(column("a")))
      vm.onAction(WorkspaceAction.ObserveDevice(column("b")))

      // "a" is reported locked; "b" is absent from the snapshot and must keep its current state.
      vm.onAction(WorkspaceAction.SetLockStates(mapOf("a" to true)))
      var state = vm.state.value as WorkspaceUiState.Content
      assertTrue("a should be locked", state.columns.first { it.deviceId == "a" }.locked)
      assertTrue("b should stay unlocked", !state.columns.first { it.deviceId == "b" }.locked)

      // A later snapshot flips both — an explicit false unlocks, an explicit true locks.
      vm.onAction(WorkspaceAction.SetLockStates(mapOf("a" to false, "b" to true)))
      state = vm.state.value as WorkspaceUiState.Content
      assertTrue("a should unlock", !state.columns.first { it.deviceId == "a" }.locked)
      assertTrue("b should lock", state.columns.first { it.deviceId == "b" }.locked)

      // An empty snapshot (e.g. a transient read gap) leaves every column unchanged.
      vm.onAction(WorkspaceAction.SetLockStates(emptyMap()))
      state = vm.state.value as WorkspaceUiState.Content
      assertTrue("a still unlocked", !state.columns.first { it.deviceId == "a" }.locked)
      assertTrue("b still locked", state.columns.first { it.deviceId == "b" }.locked)
    }
}
