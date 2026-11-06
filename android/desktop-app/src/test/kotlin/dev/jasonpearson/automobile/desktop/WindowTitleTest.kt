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

  @Test
  fun `focused device's foreground app follows the device name`() {
    val state = WorkspaceUiState.Content(listOf(pixel, iphone), focusedDeviceId = pixel.deviceId)
    assertEquals(
      "AutoMobile — Pixel 8 API 35 — com.example.app",
      windowTitle(state, mapOf(pixel.deviceId to "com.example.app")),
    )
  }

  @Test
  fun `a blank foreground app is left out`() {
    val state = WorkspaceUiState.Content(listOf(pixel), focusedDeviceId = pixel.deviceId)
    assertEquals("AutoMobile — Pixel 8 API 35", windowTitle(state, mapOf(pixel.deviceId to " ")))
  }

  @Test
  fun `the title follows the focused device's changing app`() {
    val state = WorkspaceUiState.Content(listOf(pixel), focusedDeviceId = pixel.deviceId)
    val apps = ForegroundAppsByDevice()

    apps.report(pixel.deviceId, "com.example.first")
    assertEquals(
      "AutoMobile — Pixel 8 API 35 — com.example.first",
      windowTitle(state, apps.apps.value),
    )

    apps.report(pixel.deviceId, "com.example.second")
    assertEquals(
      "AutoMobile — Pixel 8 API 35 — com.example.second",
      windowTitle(state, apps.apps.value),
    )
  }

  @Test
  fun `focus moving to a device with no app yet shows that device alone`() {
    val apps = mapOf(pixel.deviceId to "com.example.app")
    val moved = WorkspaceUiState.Content(listOf(pixel, iphone), focusedDeviceId = iphone.deviceId)
    assertEquals("AutoMobile — iPhone 16", windowTitle(moved, apps))
  }

  @Test
  fun `an app with no focused device is not shown`() {
    val apps = mapOf(pixel.deviceId to "com.example.app")
    assertEquals("AutoMobile", windowTitle(WorkspaceUiState.Content(listOf(pixel), null), apps))
    assertEquals("AutoMobile", windowTitle(WorkspaceUiState.Empty, apps))
  }

  @Test
  fun `the tracker ignores a blank package and keeps each device's own app`() {
    val apps = ForegroundAppsByDevice()
    apps.report(pixel.deviceId, "com.example.app")
    apps.report(pixel.deviceId, "")
    apps.report(iphone.deviceId, "com.example.ios")
    assertEquals(
      mapOf(pixel.deviceId to "com.example.app", iphone.deviceId to "com.example.ios"),
      apps.apps.value,
    )
  }
}
