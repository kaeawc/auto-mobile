package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** #10730: input reaches the daemon only after the desktop session allocated its device. */
class InputAllocatingClientTest {
  private val sent = CopyOnWriteArrayList<String>()
  private val allocations = CopyOnWriteArrayList<String>()
  private val delegate =
    McpDaemonClient(
      DaemonRequestTransport { request ->
        sent += request.method
        DaemonResponse(
          id = request.id,
          type = "mcp_response",
          success = true,
          result =
            buildJsonObject {
              put("action", JsonPrimitive(request.method))
              put("success", JsonPrimitive(true))
            },
        )
      },
    )

  private fun client(allowed: Boolean) =
    InputAllocatingClient(
      delegate,
      DesktopInputAllocation { deviceId ->
        allocations += deviceId
        allowed
      },
    )

  @Test
  fun `an allocated device receives the input after the allocation`() {
    val client = client(allowed = true)

    val tap = client.inputTap(540.0, 1200.0, "android", "emulator-5554")
    val key = client.inputKey("enter", "android", "emulator-5554")

    assertTrue(tap.success)
    assertTrue(key.success)
    assertEquals(listOf("emulator-5554", "emulator-5554"), allocations)
    assertEquals(listOf("input/tap", "input/key"), sent)
  }

  @Test
  fun `a refused allocation drops every input kind without a frame`() {
    val client = client(allowed = false)

    val results =
      listOf(
        client.inputTap(1.0, 2.0, "android", "emulator-5554"),
        client.inputSwipe(1.0, 2.0, 3.0, 4.0, "android", "emulator-5554"),
        client.inputPressButton("back", "android", "emulator-5554"),
        client.inputTypeText("hi", "android", "emulator-5554", append = true),
        client.inputKey("enter", "android", "emulator-5554"),
      )

    assertEquals(emptyList(), sent)
    assertEquals(
      listOf("input/tap", "input/swipe", "input/pressButton", "input/typeText", "input/key"),
      results.map { it.action },
    )
    results.forEach { result ->
      assertFalse(result.success)
      assertEquals("emulator-5554", result.deviceId)
      assertEquals(INPUT_NOT_ALLOCATED_ERROR, result.error)
    }
  }

  @Test
  fun `a refused allocation opens no gesture stream`() {
    assertNull(client(allowed = false).openGestureStream("android", "emulator-5554"))
    assertEquals(emptyList(), sent)
  }

  @Test
  fun `input without a device id targets no device and is not gated`() {
    val tap = client(allowed = false).inputTap(1.0, 2.0, "android", deviceId = null)

    assertTrue(tap.success)
    assertEquals(emptyList(), allocations)
    assertEquals(listOf("input/tap"), sent)
  }
}
