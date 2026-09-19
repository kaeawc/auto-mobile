package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import org.junit.Assert.assertEquals
import org.junit.Test

class AvailableDeviceImagesTest {

  private fun image(stableId: String, platform: String = "android") =
    DeviceImageInfo(
      name = stableId,
      platform = platform,
      identity = DeviceIdentity(stableId),
      runtime = DeviceRuntime(lifecycle = DeviceLifecycle("configured", true)),
    )

  @Test
  fun `booted Android source image is not available`() {
    val images = listOf(image("Pixel_8"), image("Pixel_7"))

    val available =
      availableDeviceImages(
        images = images,
        booted =
          listOf(
            BootedDevice(
              id = "emulator-5554",
              name = "Pixel 8",
              type = DeviceType.AndroidEmulator,
              stableId = "Pixel_8",
            )
          ),
        platform = "android",
      )

    assertEquals(listOf("Pixel_7"), available.map { it.identity.stableId })
  }

  @Test
  fun `booted iOS simulator source image is not available`() {
    val udid = "A0B1C2D3-E4F5-6789-ABCD-0123456789EF"

    val available =
      availableDeviceImages(
        images = listOf(image(udid, platform = "ios")),
        booted =
          listOf(
            BootedDevice(
              id = udid,
              name = "iPhone 15",
              type = DeviceType.iOSSimulator,
              stableId = udid,
            )
          ),
        platform = "ios",
      )

    assertEquals(emptyList<String>(), available.map { it.identity.stableId })
  }

  @Test
  fun `unrelated configured image remains available`() {
    val available =
      availableDeviceImages(
        images = listOf(image("Pixel_8")),
        booted =
          listOf(
            BootedDevice(
              id = "emulator-5554",
              name = "Pixel 7",
              type = DeviceType.AndroidEmulator,
              stableId = "Pixel_7",
            )
          ),
        platform = "android",
      )

    assertEquals(listOf("Pixel_8"), available.map { it.identity.stableId })
  }

  @Test
  fun `unresolved Android stable IDs do not hide coincidentally matching images`() {
    val runtimeId = "emulator-5554"
    val unknownRuntimeId = "Unknown (emulator-5556)"

    val available =
      availableDeviceImages(
        images = listOf(image(runtimeId), image(unknownRuntimeId)),
        booted =
          listOf(
            BootedDevice(
              id = runtimeId,
              name = "Unknown ($runtimeId)",
              type = DeviceType.AndroidEmulator,
              stableId = runtimeId,
            ),
            BootedDevice(
              id = "emulator-5556",
              name = unknownRuntimeId,
              type = DeviceType.AndroidEmulator,
              stableId = unknownRuntimeId,
            ),
          ),
        platform = "android",
      )

    assertEquals(listOf(runtimeId, unknownRuntimeId), available.map { it.identity.stableId })
  }
}
