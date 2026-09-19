package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PickerModelsTest {

  private fun booted(name: String, deviceId: String, isVirtual: Boolean) =
    BootedDeviceInfo(
      name = name,
      platform = "android",
      source = "local",
      isVirtual = isVirtual,
      identity = DeviceIdentity(deviceId),
      runtime =
        DeviceRuntime(
          deviceId = deviceId,
          connectionId = deviceId,
          lifecycle = DeviceLifecycle("booted", true),
        ),
    )

  private fun image(name: String, deviceId: String) =
    DeviceImageInfo(
      name = name,
      platform = "android",
      identity = DeviceIdentity(deviceId),
      runtime = DeviceRuntime(lifecycle = DeviceLifecycle("configured", true)),
    )

  @Test
  fun `an unresolved AVD probe preserves the successful boot attribution`() {
    val devices =
      buildPickerDevices(
        booted =
          listOf(
            booted("Unknown (emulator-5554)", "emulator-5554", true)
              .copy(identity = DeviceIdentity("Unknown (emulator-5554)"))
          ),
        images = listOf(image("Pixel", "avd_a")),
        sourceImageToRuntimeId = mapOf("avd_a" to "emulator-5554"),
      )
    assertEquals(listOf("emulator-5554"), devices.map { it.id })
  }

  @Test
  fun `stable source identity joins an unresolved name and overrides a recycled serial attribution`() {
    val devices =
      buildPickerDevices(
        booted =
          listOf(
            booted("Unknown (emulator-5554)", "emulator-5554", true)
              .copy(
                identity = DeviceIdentity("avd_b"),
                runtime =
                  DeviceRuntime(
                    deviceId = "emulator-5554",
                    connectionId = "transport-new",
                    deviceSessionUuid = "epoch-new",
                    lifecycle = DeviceLifecycle("booted", true),
                  ),
              )
          ),
        images = listOf(image("Pixel", "avd_a"), image("Pixel", "avd_b")),
        sourceImageToRuntimeId = mapOf("avd_a" to "emulator-5554"),
      )
    assertEquals(listOf("emulator-5554", "avd_a"), devices.map { it.id })
    assertEquals("epoch-new", devices.first().deviceSessionUuid)
  }

  @Test
  fun `a legacy name match never hides a device on a different platform`() {
    val devices =
      buildPickerDevices(
        booted = listOf(booted("Shared name", "emulator-5554", true)),
        images = listOf(image("Shared name", "ios-udid").copy(platform = "ios")),
      )
    assertEquals(listOf("emulator-5554", "ios-udid"), devices.map { it.id })
  }

  @Test
  fun `an ambiguous legacy name preserves both distinct source images`() {
    val devices =
      buildPickerDevices(
        booted = listOf(booted("Pixel 8", "emulator-5554", isVirtual = true)),
        images = listOf(image("Pixel 8", "avd_a"), image("Pixel 8", "avd_b")),
      )
    assertTrue(devices.any { it.id == "emulator-5554" && it.state == DeviceState.Booted })
    // No stable identity is available: a positional guess would hide a distinct device.
    assertEquals(2, devices.count { it.state == DeviceState.Shutdown && it.name == "Pixel 8" })
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
  fun `an in-session attribution hides the exact source image, not a positional same-named one`() {
    // Booting the SECOND same-named image: the map attributes avd_b -> emu-b, so avd_a must
    // survive.
    val devices =
      buildPickerDevices(
        booted = listOf(booted("Pixel 8", "emu-b", isVirtual = true)),
        images = listOf(image("Pixel 8", "avd_a"), image("Pixel 8", "avd_b")),
        sourceImageToRuntimeId = mapOf("avd_b" to "emu-b"),
      )
    assertTrue(devices.any { it.id == "emu-b" && it.state == DeviceState.Booted })
    assertTrue(devices.any { it.id == "avd_a" && it.state == DeviceState.Shutdown })
    assertTrue(devices.none { it.id == "avd_b" })
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

  @Test
  fun `booted device preserves its virtual kind for workspace controls`() {
    val physical =
      buildPickerDevices(
        booted =
          listOf(
            BootedDeviceInfo(
              name = "iPhone 15",
              platform = "ios",
              source = "local",
              isVirtual = false,
              identity = DeviceIdentity("udid-1"),
              runtime =
                DeviceRuntime(
                  deviceId = "udid-1",
                  connectionId = "udid-1",
                  lifecycle = DeviceLifecycle("booted", true),
                ),
            )
          ),
        images = emptyList(),
      )

    assertEquals(false, physical.single().isVirtual)
  }

  @Test
  fun `booted devices derive OS grouping from their platform`() {
    val devices =
      buildPickerDevices(
        booted =
          listOf(
            BootedDeviceInfo(
              name = "iPhone 15",
              platform = "ios",
              source = "local",
              isVirtual = true,
              identity = DeviceIdentity("ios-udid"),
              osVersion = "17.0",
              runtime =
                DeviceRuntime(
                  deviceId = "ios-udid",
                  connectionId = "ios-udid",
                  lifecycle = DeviceLifecycle("booted", true),
                ),
            ),
            BootedDeviceInfo(
              name = "Pixel 8",
              platform = "android",
              source = "local",
              isVirtual = true,
              identity = DeviceIdentity("android-id"),
              apiLevel = 34,
              runtime =
                DeviceRuntime(
                  deviceId = "android-id",
                  connectionId = "android-id",
                  lifecycle = DeviceLifecycle("booted", true),
                ),
            ),
          ),
        images = emptyList(),
      )

    assertEquals("17", devices.first { it.id == "ios-udid" }.osKey)
    assertEquals("iOS 17", devices.first { it.id == "ios-udid" }.osLabel)
    assertEquals("34", devices.first { it.id == "android-id" }.osKey)
    assertEquals("API 34", devices.first { it.id == "android-id" }.osLabel)
  }

  @Test
  fun `booted device preserves its live session UUID for workspace scoping`() {
    val devices =
      buildPickerDevices(
        booted =
          listOf(
            BootedDeviceInfo(
              name = "Pixel 8",
              platform = "android",
              source = "local",
              isVirtual = true,
              identity = DeviceIdentity("Pixel_8"),
              runtime =
                DeviceRuntime(
                  deviceId = "emulator-5554",
                  connectionId = "emulator-5554",
                  deviceSessionUuid = "epoch-a",
                  lifecycle = DeviceLifecycle("booted", true),
                ),
            )
          ),
        images = emptyList(),
      )

    assertEquals("epoch-a", devices.single().deviceSessionUuid)
  }
}
