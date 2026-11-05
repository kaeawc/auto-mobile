package dev.jasonpearson.automobile.desktop

import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import kotlin.test.Test
import kotlin.test.assertEquals

class WindowTitleTest {
  private val pixel =
    DeviceColumn(deviceId = "emulator-5554", name = "Pixel 8 API 35", Platform.Android)
  private val iphone = DeviceColumn(deviceId = "UDID-1", name = "iPhone 16", Platform.Ios)

  @Test
  fun `empty workspace shows the app name alone`() {
    assertEquals("AutoMobile", windowTitle(WorkspaceUiState.Empty))
  }

  @Test
  fun `focused device name follows the app name`() {
    val state = WorkspaceUiState.Content(listOf(pixel, iphone), focusedDeviceId = "UDID-1")
    assertEquals("AutoMobile — iPhone 16", windowTitle(state))
  }

  @Test
  fun `no focused device shows the app name alone`() {
    assertEquals("AutoMobile", windowTitle(WorkspaceUiState.Content(listOf(pixel), null)))
  }

  @Test
  fun `a focus id with no matching column shows the app name alone`() {
    assertEquals("AutoMobile", windowTitle(WorkspaceUiState.Content(listOf(pixel), "gone")))
  }

  @Test
  fun `a blank device name shows the app name alone`() {
    val blank = pixel.copy(name = " ")
    assertEquals(
      "AutoMobile",
      windowTitle(WorkspaceUiState.Content(listOf(blank), blank.deviceId)),
    )
  }
}
