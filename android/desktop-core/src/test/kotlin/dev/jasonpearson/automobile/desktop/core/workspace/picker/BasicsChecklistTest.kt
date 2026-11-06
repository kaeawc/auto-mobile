package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrapState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonLifecyclePhase
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import org.junit.Assert.assertEquals
import org.junit.Test

class BasicsChecklistTest {

  private val booted = PickerDevice("p8", "Pixel 8", Platform.Android, DeviceState.Booted)
  private val shutdown = PickerDevice("i15", "iPhone 15", Platform.Ios, DeviceState.Shutdown)

  private fun done(
    bootstrap: DaemonBootstrapState,
    picker: DevicePickerUiState,
    observed: Boolean = false,
  ): List<Boolean> = basicsChecklist(bootstrap, picker, observed).map { it.done }

  @Test
  fun `lists the three basics in order`() {
    assertEquals(
      listOf(BasicsStep.DaemonReady, BasicsStep.DeviceVisible, BasicsStep.DeviceObserved),
      basicsChecklist(DaemonBootstrapState.Unknown, DevicePickerUiState.Loading, false).map {
        it.step
      },
    )
  }

  @Test
  fun `nothing is ticked while the daemon is still starting`() {
    val working = DaemonBootstrapState.Working(DaemonLifecyclePhase.Verifying)
    assertEquals(listOf(false, false, false), done(working, DevicePickerUiState.Loading))
  }

  @Test
  fun `a ready bootstrap ticks the daemon before the list loads`() {
    assertEquals(
      listOf(true, false, false),
      done(DaemonBootstrapState.Ready(restarted = false), DevicePickerUiState.Loading),
    )
  }

  @Test
  fun `a loaded list ticks the daemon on a transport the app does not bootstrap`() {
    val content = DevicePickerUiState.Content(listOf(shutdown))
    assertEquals(listOf(true, false, false), done(DaemonBootstrapState.Inactive, content))
    assertEquals(listOf(true, false, false), done(DaemonBootstrapState.Unknown, content))
  }

  @Test
  fun `a failed bootstrap unticks the daemon even over stale content`() {
    val content = DevicePickerUiState.Content(listOf(booted))
    assertEquals(listOf(false, true, false), done(DaemonBootstrapState.Failed("down"), content))
  }

  @Test
  fun `only a booted device counts as visible`() {
    val ready = DaemonBootstrapState.Ready(restarted = false)
    assertEquals(
      listOf(true, false, false),
      done(ready, DevicePickerUiState.Content(listOf(shutdown))),
    )
    assertEquals(
      listOf(true, true, false),
      done(ready, DevicePickerUiState.Content(listOf(shutdown, booted))),
    )
  }

  @Test
  fun `an observed workspace ticks the last step`() {
    assertEquals(
      listOf(true, true, true),
      done(
        DaemonBootstrapState.Ready(restarted = true),
        DevicePickerUiState.Content(listOf(booted)),
        observed = true,
      ),
    )
  }
}
