package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime
import dev.jasonpearson.automobile.desktop.core.shell.ShellDeviceSource
import dev.jasonpearson.automobile.desktop.core.shell.shellBootedDevice
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
            shellBootedDevice(
              deviceId = "emulator-5554",
              name = "Pixel 8",
              platform = "android",
              source = ShellDeviceSource(stableId = "Pixel_8"),
            ),
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
            shellBootedDevice(
              deviceId = udid,
              name = "iPhone 15",
              platform = "ios",
              source = ShellDeviceSource(stableId = udid),
            ),
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
            shellBootedDevice(
              deviceId = "emulator-5554",
              name = "Pixel 7",
              platform = "android",
              source = ShellDeviceSource(stableId = "Pixel_7"),
            ),
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
            shellBootedDevice(
              deviceId = runtimeId,
              name = "Unknown ($runtimeId)",
              platform = "android",
              source = ShellDeviceSource(stableId = runtimeId),
            ),
            shellBootedDevice(
              deviceId = "emulator-5556",
              name = unknownRuntimeId,
              platform = "android",
              source = ShellDeviceSource(stableId = unknownRuntimeId),
            ),
          ),
        platform = "android",
      )

    assertEquals(listOf(runtimeId, unknownRuntimeId), available.map { it.identity.stableId })
  }

  @Test
  fun `booted Android stableId does not hide iOS image`() {
    val sharedStableId = "shared-id-123"

    assertEquals(
      listOf(sharedStableId),
      availableDeviceImages(
          images = listOf(image(sharedStableId, platform = "ios")),
          booted =
            listOf(
              shellBootedDevice(
                deviceId = "android-runtime-id",
                name = "Android device",
                platform = "android",
                source = ShellDeviceSource(stableId = sharedStableId),
              ),
            ),
          platform = "ios",
        )
        .map { it.identity.stableId },
    )
  }

  @Test
  fun `booted iOS stableId does not hide Android image`() {
    val sharedStableId = "shared-id-123"

    assertEquals(
      listOf(sharedStableId),
      availableDeviceImages(
          images = listOf(image(sharedStableId)),
          booted =
            listOf(
              shellBootedDevice(
                deviceId = sharedStableId,
                name = "iOS device",
                platform = "ios",
                source = ShellDeviceSource(stableId = sharedStableId),
              ),
            ),
          platform = "android",
        )
        .map { it.identity.stableId },
    )
  }
}
