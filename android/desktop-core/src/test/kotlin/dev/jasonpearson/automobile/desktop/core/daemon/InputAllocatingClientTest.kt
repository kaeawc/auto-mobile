package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** #10730: input reaches the daemon only after the desktop session allocated its device. */
class InputAllocatingClientTest {
  private val sent = CopyOnWriteArrayList<String>()
  private val toolArguments = CopyOnWriteArrayList<JsonObject>()
  private val allocations = CopyOnWriteArrayList<String>()
  private val params = CopyOnWriteArrayList<JsonObject>()
  private val events = CopyOnWriteArrayList<String>()
  private val delegate =
    McpDaemonClient(
      DaemonRequestTransport { request ->
        sent += request.method
        params += request.params
        events += "send:${request.method}"
        (request.params["arguments"] as? JsonObject)?.let(toolArguments::add)
        DaemonResponse(
          id = request.id,
          type = "mcp_response",
          success = true,
          result =
            if (request.method == "tools/call") {
              okToolResult()
            } else {
              buildJsonObject {
                put("action", JsonPrimitive(request.method))
                put("success", JsonPrimitive(true))
              }
            },
        )
      },
    )

  private fun okToolResult() = buildJsonObject {
    put(
      "content",
      buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", """{"success":true,"message":""}""")
          },
        )
      },
    )
  }

  private fun client(allowed: Boolean, sessionUuid: String? = null) =
    InputAllocatingClient(
      delegate,
      DesktopInputAllocation { deviceId ->
        allocations += deviceId
        events += "allocate:$deviceId"
        allowed
      },
      sessionUuidProvider = { sessionUuid },
    )

  private fun rotateArguments() = buildJsonObject {
    put("orientation", "landscape")
    put("platform", "android")
    put("deviceId", "emulator-5554")
  }

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

  @Test
  fun `a device-targeted tool call allocates first and runs as the desktop session`() {
    val client = client(allowed = true, sessionUuid = "desktop-1")

    client.callToolChecked("rotate", rotateArguments())

    assertEquals(listOf("emulator-5554"), allocations)
    assertEquals(listOf("tools/call"), sent)
    assertEquals(JsonPrimitive("desktop-1"), toolArguments.single()["sessionUuid"])
    assertEquals(JsonPrimitive("emulator-5554"), toolArguments.single()["deviceId"])
  }

  @Test
  fun `a refused allocation drops a device-targeted tool call without a frame`() {
    val client = client(allowed = false, sessionUuid = "desktop-1")

    val error =
      assertFailsWith<McpConnectionException> {
        client.callToolChecked("rotate", rotateArguments())
      }

    assertEquals(INPUT_NOT_ALLOCATED_ERROR, error.message)
    assertEquals(listOf("emulator-5554"), allocations)
    assertEquals(emptyList(), sent)
  }

  @Test
  fun `a tool call without a device id is neither gated nor named`() {
    client(allowed = false, sessionUuid = "desktop-1").callTool("listDevices", buildJsonObject {})

    assertEquals(emptyList(), allocations)
    assertEquals(listOf("tools/call"), sent)
    assertNull(toolArguments.single()["sessionUuid"])
  }

  @Test
  fun `key-value writes allocate before the frame and carry the desktop session`() {
    val client = client(allowed = true, sessionUuid = "desktop-1")

    client.setKeyValue("emulator-5554", "app", "prefs", "k", "v", "string")
    client.removeKeyValue("emulator-5554", "app", "prefs", "k")
    client.clearKeyValueFile("emulator-5554", "app", "prefs")

    assertEquals(
      listOf(
        "allocate:emulator-5554",
        "send:ide/setKeyValue",
        "allocate:emulator-5554",
        "send:ide/removeKeyValue",
        "allocate:emulator-5554",
        "send:ide/clearKeyValueFile",
      ),
      events,
    )
    assertEquals(List(3) { JsonPrimitive("desktop-1") }, params.map { it["sessionUuid"] })
  }

  @Test
  fun `a refused allocation fails a key-value write without a frame`() {
    val client = client(allowed = false, sessionUuid = "desktop-1")

    val results =
      listOf(
        client.setKeyValue("emulator-5554", "app", "prefs", "k", "v", "string").message,
        client.removeKeyValue("emulator-5554", "app", "prefs", "k").message,
        client.clearKeyValueFile("emulator-5554", "app", "prefs").message,
      )

    assertEquals(List(3) { INPUT_NOT_ALLOCATED_ERROR }, results)
    assertEquals(emptyList(), sent)
  }

  @Test
  fun `resource reads never allocate`() {
    client(allowed = false, sessionUuid = "desktop-1").runCatching {
      readResource("automobile:devices/emulator-5554/app/storage/files")
    }

    assertEquals(emptyList(), allocations)
  }
}
