package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.daemon.INPUT_NOT_ALLOCATED_ERROR
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.InputAllocatingClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the [DaemonEmulatorControlExecutor]'s tool-argument construction (the correctness-critical
 * part of the otherwise-untested IO seam) against a [FakeAutoMobileClient]. The real socket
 * transport stays untested, consistent with `DaemonMcpResourceClient`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DaemonEmulatorControlExecutorTest {

  private fun toolResponse(
    success: Boolean,
    message: String,
    error: String? = null,
  ): JsonElement {
    val payload = buildJsonObject {
      put("success", success)
      put("message", message)
      error?.let { put("error", it) }
    }
    return buildJsonObject {
      put(
        "content",
        kotlinx.serialization.json.buildJsonArray {
          add(
            buildJsonObject {
              put("type", "text")
              put("text", payload.toString())
            },
          )
        },
      )
    }
  }

  private fun deviceLossToolResponse(): JsonElement = buildJsonObject {
    put("isError", true)
    put(
      "content",
      kotlinx.serialization.json.buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", """{"code":"device_lost","reason":"confirmed-unavailable"}""")
          },
        )
      },
    )
  }

  private fun plainTextToolErrorResponse(text: String): JsonElement = buildJsonObject {
    put("isError", true)
    put(
      "content",
      kotlinx.serialization.json.buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", text)
          },
        )
      },
    )
  }

  private fun executor(
    client: FakeAutoMobileClient,
    resolver: ForegroundAppResolver = FakeForegroundAppResolver(appId = null),
  ): DaemonEmulatorControlExecutor {
    if (client.callToolResult == kotlinx.serialization.json.JsonObject(emptyMap())) {
      client.callToolResult = toolResponse(success = true, message = "")
    }
    return DaemonEmulatorControlExecutor(client, resolver, UnconfinedTestDispatcher())
  }

  @Test
  fun `rotate calls rotate with the target orientation and allocates nothing itself`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client)
      .run("emulator-5554", Platform.Android, EmulatorControl.Rotate, Orientation.Landscape)

    // #10730: allocation belongs to the desktop session's input client, never a setActiveDevice.
    assertTrue("setActiveDevice" !in client.calls)
    assertTrue(
      "rotate enables its exact tool",
      client.toolCalls.any {
        it.name == "setToolEnabled" &&
          it.arguments ==
            buildJsonObject {
              put("toolName", "rotate")
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
      },
    )
  }

  @Test
  fun `snapshot enables its exact tool and captures on the target device`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client)
      .run("emulator-5554", Platform.Android, EmulatorControl.Snapshot, Orientation.Portrait)

    assertTrue("setActiveDevice" !in client.calls)
    assertTrue(
      client.toolCalls.any {
        it.name == "setToolEnabled" &&
          it.arguments ==
            buildJsonObject {
              put("toolName", "deviceSnapshot")
              put("enabled", true)
            }
      },
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
      },
    )
  }

  @Test
  fun `unlock calls wakeAndUnlock with the ios platform`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client).run("booted-ipad", Platform.Ios, EmulatorControl.Unlock, Orientation.Portrait)

    assertTrue("setActiveDevice" !in client.calls)
    assertTrue(
      client.toolCalls.any {
        it.name == "wakeAndUnlock" &&
          it.arguments ==
            buildJsonObject {
              put("platform", "ios")
              put("deviceId", "booted-ipad")
            }
      },
    )
  }

  @Test
  fun `pressButton sends a single inputPressButton without setActiveDevice`() = runTest {
    // The fast path is Unix-transport only (the direct input/* helpers live there).
    val client = FakeAutoMobileClient().apply { transportName = "Unix Socket" }
    executor(client).pressButton("emulator-5554", Platform.Android, DeviceButton.Home)

    // The fast path: no setActiveDevice pre-call, no heavier pressButton MCP tool — one direct
    // input/pressButton round-trip, exactly like the video-pane tap path.
    assertTrue("setActiveDevice" !in client.calls)
    assertTrue(client.toolCalls.none { it.name == "pressButton" })
    val call = client.inputPressButtonCalls.single()
    assertEquals("home", call.button)
    assertEquals("android", call.platform)
    assertEquals("emulator-5554", call.deviceId)
    assertNull(call.frameContext)
  }

  @Test
  fun `pressButton goes through the session-naming input client when one is given`() = runTest {
    // #10698: the daemon accepts input for a held device only from its holder, so the desktop hands
    // the executor a client that names its session.
    val client = FakeAutoMobileClient().apply { transportName = "Unix Socket" }
    val inputClient = FakeAutoMobileClient().apply { transportName = "Unix Socket" }
    DaemonEmulatorControlExecutor(
        client,
        inputClient = inputClient,
        foregroundAppResolver = FakeForegroundAppResolver(appId = null),
        ioDispatcher = UnconfinedTestDispatcher(),
      )
      .pressButton("emulator-5554", Platform.Android, DeviceButton.Back)

    assertTrue(client.inputPressButtonCalls.isEmpty())
    assertEquals("back", inputClient.inputPressButtonCalls.single().button)
  }

  @Test
  fun `a non-Unix transport routes pressButton through the pressButton MCP tool`() = runTest {
    // MCP HTTP/STDIO transports don't serve the direct input/* helpers, so the command bar must
    // fall back to the transport-agnostic pressButton tool (its pre-fast-path behavior) instead of
    // failing every button. transportName != "Unix Socket" selects the fallback.
    val client = FakeAutoMobileClient().apply { transportName = "MCP HTTP" }
    executor(client).pressButton("emulator-5554", Platform.Android, DeviceButton.Home)

    assertTrue(client.inputPressButtonCalls.isEmpty())
    assertTrue("setActiveDevice" !in client.calls)
    assertTrue(
      client.toolCalls.any {
        it.name == "pressButton" &&
          it.arguments ==
            buildJsonObject {
              put("button", "home")
              put("platform", "android")
              put("deviceId", "emulator-5554")
            }
      },
    )
  }

  @Test
  fun `an input-pressButton failure is propagated`() = runTest {
    val client =
      FakeAutoMobileClient().apply {
        transportName = "Unix Socket"
        inputPressButtonResult =
          InputActionResult(
            action = "input/pressButton",
            success = false,
            error = "Unsupported button",
          )
      }

    var failureMessage: String? = null
    try {
      executor(client).pressButton("emulator-5554", Platform.Android, DeviceButton.Home)
      fail("Expected input failure")
    } catch (error: McpConnectionException) {
      failureMessage = error.message
    }

    assertEquals("Unsupported button", failureMessage)
  }

  @Test
  fun `MCP error envelope is propagated from device control`() = runTest {
    val client =
      FakeAutoMobileClient().apply {
        callToolResult = deviceLossToolResponse()
      }

    try {
      executor(client)
        .run(
          "emulator-5554",
          Platform.Android,
          EmulatorControl.Unlock,
          Orientation.Portrait,
        )
      fail("Expected MCP tool failure")
    } catch (error: McpConnectionException) {
      assertEquals("confirmed-unavailable", error.message)
    }
  }

  @Test
  fun `plain text MCP error preserves the proxy message`() {
    val client =
      FakeAutoMobileClient().apply {
        callToolResult = plainTextToolErrorResponse("Error: rotate failed")
      }

    try {
      client.callToolChecked("rotate", buildJsonObject {})
      fail("Expected MCP tool failure")
    } catch (error: McpConnectionException) {
      assertEquals("rotate failed", error.message)
    }
  }

  @Test
  fun `non-object MCP error payload is not treated as success`() {
    val client =
      FakeAutoMobileClient().apply {
        callToolResult = plainTextToolErrorResponse("[]")
      }

    try {
      client.callToolChecked("rotate", buildJsonObject {})
      fail("Expected MCP tool failure")
    } catch (error: McpConnectionException) {
      assertEquals("[]", error.message)
    }
  }

  @Test
  fun `capability failure is not silently ignored`() {
    val client =
      FakeAutoMobileClient().apply {
        callToolResult = plainTextToolErrorResponse("Error: capability denied")
      }

    try {
      client.setToolEnabled("rotate")
      fail("Expected capability failure")
    } catch (error: McpConnectionException) {
      assertEquals("capability denied", error.message)
    }
  }

  @Test
  fun `every device control runs on the desktop input client, none on the shared client`() =
    runTest {
      // #10730: rotate, snapshot, unlock and locale are active use, so they allocate through the
      // desktop session's input client; the shared graph client never touches the device.
      val client = FakeAutoMobileClient().apply { transportName = "Unix Socket" }
      val inputClient =
        FakeAutoMobileClient().apply {
          transportName = "Unix Socket"
          callToolResult = toolResponse(success = true, message = "")
        }
      val executor =
        DaemonEmulatorControlExecutor(
          client,
          inputClient = inputClient,
          foregroundAppResolver = FakeForegroundAppResolver(appId = "com.example.app"),
          ioDispatcher = UnconfinedTestDispatcher(),
        )

      listOf(EmulatorControl.Rotate, EmulatorControl.Snapshot, EmulatorControl.Unlock).forEach {
        executor.run("emulator-5554", Platform.Android, it, Orientation.Landscape)
      }
      executor.setLocale("emulator-5554", Platform.Android, "de-DE")

      assertTrue(client.calls.isEmpty())
      assertTrue(client.toolCalls.isEmpty())
      assertEquals(
        listOf("rotate", "deviceSnapshot", "wakeAndUnlock", "changeLocalization"),
        inputClient.toolCalls.map { it.name }.filter { it != "setToolEnabled" },
      )
    }

  @Test
  fun `a control on a device another session holds is refused before any tool call`() = runTest {
    val delegate =
      FakeAutoMobileClient().apply { callToolResult = toolResponse(success = true, message = "") }
    val allocations = mutableListOf<String>()
    val inputClient =
      InputAllocatingClient(
        delegate,
        DesktopInputAllocation { deviceId ->
          allocations += deviceId
          false
        },
      )
    val executor =
      DaemonEmulatorControlExecutor(
        FakeAutoMobileClient(),
        inputClient = inputClient,
        foregroundAppResolver = FakeForegroundAppResolver(appId = null),
        ioDispatcher = UnconfinedTestDispatcher(),
      )

    try {
      executor.run("emulator-5554", Platform.Android, EmulatorControl.Rotate, Orientation.Landscape)
      fail("Expected the refused allocation to drop the control")
    } catch (error: McpConnectionException) {
      assertEquals(INPUT_NOT_ALLOCATED_ERROR, error.message)
    }

    assertEquals(listOf("emulator-5554"), allocations)
    assertTrue(delegate.toolCalls.none { it.name == "rotate" })
    assertTrue("setActiveDevice" !in delegate.calls)
  }

  @Test
  fun `setLocale on iOS enables changeLocalization and changes locale device-wide`() = runTest {
    val client = FakeAutoMobileClient()
    executor(client).setLocale("booted-ipad", Platform.Ios, "ja-JP")

    assertTrue(
      client.toolCalls.any {
        it.name == "setToolEnabled" &&
          it.arguments ==
            buildJsonObject {
              put("toolName", "changeLocalization")
              put("enabled", true)
            }
      },
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
      },
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
