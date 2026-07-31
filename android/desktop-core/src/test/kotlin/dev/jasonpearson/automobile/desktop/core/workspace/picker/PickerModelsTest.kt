package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PickerModelsTest {

  private fun booted(name: String, deviceId: String, isVirtual: Boolean) =
    BootedDeviceInfo(
      name = name,
      platform = "android",
      deviceId = deviceId,
      source = "local",
      isVirtual = isVirtual,
      status = "booted",
    )

  private fun image(name: String, deviceId: String) =
    DeviceImageInfo(name = name, platform = "android", deviceId = deviceId)

  @Test
  fun `a re-keyed virtual device hides exactly one same-named image, not both`() {
    val devices =
      buildPickerDevices(
        booted = listOf(booted("Pixel 8", "emulator-5554", isVirtual = true)),
        images = listOf(image("Pixel 8", "avd_a"), image("Pixel 8", "avd_b")),
      )
    assertTrue(devices.any { it.id == "emulator-5554" && it.state == DeviceState.Booted })
    // Virtual re-key hides one same-named image; the distinct sibling remains bootable.
    assertEquals(1, devices.count { it.state == DeviceState.Shutdown && it.name == "Pixel 8" })
  }

  @Test
  fun `a physical booted device does not hide a same-named shutdown image`() {
    val devices =
      buildPickerDevices(
        booted = listOf(booted("Pixel 8", "serial-123", isVirtual = false)),
        images = listOf(image("Pixel 8", "avd_x")),
      )
    assertTrue(devices.any { it.id == "serial-123" && it.state == DeviceState.Booted })
    // Physical devices are not re-keyed: the distinct same-named image is NOT mis-hidden.
    assertTrue(devices.any { it.id == "avd_x" && it.state == DeviceState.Shutdown })
  }

  @Test
  fun `an image whose exact id is booted is hidden regardless of virtual flag`() {
    // e.g. an iOS simulator whose UDID is stable across boot — dedup by exact identity.
    val devices =
      buildPickerDevices(
        booted = listOf(booted("iPhone 15", "udid-1", isVirtual = true)),
        images = listOf(image("iPhone 15", "udid-1")),
      )
    assertEquals(listOf("udid-1"), devices.map { it.id })
    assertTrue(devices.single().state == DeviceState.Booted)
  }
}
