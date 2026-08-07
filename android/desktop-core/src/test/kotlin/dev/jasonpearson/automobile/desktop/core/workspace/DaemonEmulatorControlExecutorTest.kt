package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the [DaemonEmulatorControlExecutor]'s tool-argument construction (the correctness-critical
 * part of the otherwise-untested IO seam) against a [FakeAutoMobileClient]. The real socket
 * transport stays untested, consistent with `DaemonMcpResourceClient`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DaemonEmulatorControlExecutorTest {

  private fun executor(
    client: FakeAutoMobileClient,
    resolver: ForegroundAppResolver = FakeForegroundAppResolver(appId = null),
  ) = DaemonEmulatorControlExecutor(client, resolver, UnconfinedTestDispatcher())

  @Test
  fun `rotate sets the active device then calls rotate with the target orientation`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client)
      .run("emulator-5554", Platform.Android, EmulatorControl.Rotate, Orientation.Landscape)

    // Active device is set before any tool call.
    assertEquals("setActiveDevice", client.calls.first())
    assertTrue(
      "rotate needs the advanced-interaction capability",
      client.toolCalls.any {
        it.name == "setToolCapability" &&
          it.arguments ==
            buildJsonObject {
              put("capability", "advanced-interaction")
              put("enabled", true)
            }
      },
    )
    assertTrue(
      client.toolCalls.any {
        it.name == "rotate" &&
          it.arguments ==
            buildJsonObject {
              put("orientation", "landscape")
              put("platform", "android")
              put("deviceId", "emulator-5554")
            }
      }
    )
  }

  @Test
  fun `snapshot enables screen-artifacts and captures on the target device`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client)
      .run("emulator-5554", Platform.Android, EmulatorControl.Snapshot, Orientation.Portrait)

    assertEquals("setActiveDevice", client.calls.first())
    assertTrue(
      client.toolCalls.any {
        it.name == "setToolCapability" &&
          it.arguments ==
            buildJsonObject {
              put("capability", "screen-artifacts")
              put("enabled", true)
            }
      }
    )
    assertTrue(
      client.toolCalls.any {
        it.name == "deviceSnapshot" &&
          it.arguments ==
            buildJsonObject {
              put("action", "capture")
              put("platform", "android")
              put("deviceId", "emulator-5554")
            }
      }
    )
  }

  @Test
  fun `unlock calls wakeAndUnlock with the ios platform`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client).run("booted-ipad", Platform.Ios, EmulatorControl.Unlock, Orientation.Portrait)

    assertEquals("setActiveDevice", client.calls.first())
    assertTrue(
      client.toolCalls.any {
        it.name == "wakeAndUnlock" &&
          it.arguments ==
            buildJsonObject {
              put("platform", "ios")
              put("deviceId", "booted-ipad")
            }
      }
    )
  }

  @Test
  fun `pressButton sets the active device then calls pressButton`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client).pressButton("emulator-5554", Platform.Android, DeviceButton.Home)

    assertEquals("setActiveDevice", client.calls.first())
    assertTrue(
      client.toolCalls.any {
        it.name == "pressButton" &&
          it.arguments ==
            buildJsonObject {
              put("button", "home")
              put("platform", "android")
              put("deviceId", "emulator-5554")
            }
      }
    )
  }

  @Test
  fun `setLocale on iOS enables device-settings and changes locale device-wide`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client).setLocale("booted-ipad", Platform.Ios, "ja-JP")

    assertTrue(
      client.toolCalls.any {
        it.name == "setToolCapability" &&
          it.arguments ==
            buildJsonObject {
              put("capability", "device-settings")
              put("enabled", true)
            }
      }
    )
    assertTrue(
      "iOS locale is device-wide — no appId",
      client.toolCalls.any {
        it.name == "changeLocalization" &&
          it.arguments ==
            buildJsonObject {
              put("locale", "ja-JP")
              put("platform", "ios")
              put("deviceId", "booted-ipad")
            }
      },
    )
  }

  @Test
  fun `setLocale on iOS relaunches the resolved foreground app so the change is visible`() =
    runTest {
      val client = FakeAutoMobileClient()
      val resolver = FakeForegroundAppResolver(appId = "com.example.iosapp")
      executor(client, resolver).setLocale("booted-ipad", Platform.Ios, "ja-JP")

      assertEquals(listOf("booted-ipad"), resolver.requestedDeviceIds)
      assertTrue(
        "iOS passes the foreground bundle as restartApp (never appId) so the running app relaunches",
        client.toolCalls.any {
          it.name == "changeLocalization" &&
            it.arguments ==
              buildJsonObject {
                put("locale", "ja-JP")
                put("platform", "ios")
                put("deviceId", "booted-ipad")
                put("restartApp", "com.example.iosapp")
              }
        },
      )
    }

  @Test
  fun `setLocale on Android targets the resolved foreground app`() = runTest {
    val client = FakeAutoMobileClient()
    val resolver = FakeForegroundAppResolver(appId = "com.example.app")
    executor(client, resolver).setLocale("emulator-5554", Platform.Android, "de-DE")

    assertEquals(listOf("emulator-5554"), resolver.requestedDeviceIds)
    assertTrue(
      client.toolCalls.any {
        it.name == "changeLocalization" &&
          it.arguments ==
            buildJsonObject {
              put("locale", "de-DE")
              put("platform", "android")
              put("deviceId", "emulator-5554")
              put("appId", "com.example.app")
            }
      }
    )
  }

  @Test
  fun `setLocale on Android with no foreground app does not change locale`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client, FakeForegroundAppResolver(appId = null))
      .setLocale("emulator-5554", Platform.Android, "de-DE")

    assertTrue(client.toolCalls.none { it.name == "changeLocalization" })
  }
}
