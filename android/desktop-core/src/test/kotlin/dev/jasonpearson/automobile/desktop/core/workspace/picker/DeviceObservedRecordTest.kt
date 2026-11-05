package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceObservedRecordTest {

  private val observedWorkspace =
    WorkspaceUiState.Content(
      columns =
        listOf(DeviceColumn(deviceId = "p8", name = "Pixel 8", platform = Platform.Android)),
      focusedDeviceId = "p8",
    )

  @Test
  fun `an empty workspace records nothing`() {
    val settings = FakeSettingsProvider()
    val record = DeviceObservedRecord(settings)

    record.record(WorkspaceUiState.Empty)

    assertFalse(record.observed)
    assertFalse(settings.hasObservedDevice)
  }

  @Test
  fun `the first observed workspace latches and persists`() {
    val settings = FakeSettingsProvider()
    val record = DeviceObservedRecord(settings)

    record.record(observedWorkspace)

    assertTrue(record.observed)
    assertTrue(settings.hasObservedDevice)
  }

  @Test
  fun `closing every pane keeps the step ticked`() {
    val record = DeviceObservedRecord(FakeSettingsProvider())

    record.record(observedWorkspace)
    record.record(WorkspaceUiState.Empty)

    assertTrue(record.observed)
  }

  @Test
  fun `a later launch starts ticked from settings`() {
    val settings = FakeSettingsProvider(FakeSettingsProvider.Values(hasObservedDevice = true))

    assertTrue(DeviceObservedRecord(settings).observed)
  }
}
