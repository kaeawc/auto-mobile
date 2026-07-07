package dev.jasonpearson.automobile.desktop.core.testing

import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.InputCoordinates
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpTool
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveResult
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveScreenSize
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeAutoMobileClientTest {

  @Test
  fun `records method calls in order`() {
    val client = FakeAutoMobileClient()

    client.ping()
    client.listTools()
    client.observe()
    client.inputTap(x = 10, y = 20)
    client.close()

    assertEquals(listOf("ping", "listTools", "observe", "inputTap", "close"), client.calls)
  }

  @Test
  fun `returns configurable listTools result`() {
    val client = FakeAutoMobileClient()
    val tools = listOf(McpTool(name = "observe", description = "Observe screen"))
    client.listToolsResult = tools

    assertEquals(tools, client.listTools())
  }

  @Test
  fun `returns configurable listResources result`() {
    val client = FakeAutoMobileClient()
    val resources = listOf(McpResource(uri = "automobile:devices", name = "devices"))
    client.listResourcesResult = resources

    assertEquals(resources, client.listResources())
  }

  @Test
  fun `returns configurable observe result`() {
    val client = FakeAutoMobileClient()
    val result =
      ObserveResult(
        updatedAt = 12345L,
        screenSize = ObserveScreenSize(width = 1080, height = 1920),
        rotation = 0,
      )
    client.observeResult = result

    assertEquals(result, client.observe("android"))
  }

  @Test
  fun `returns configurable startDevice result`() {
    val client = FakeAutoMobileClient()
    client.startDeviceResult = StartDeviceResult(success = true, deviceId = "emulator-5554")

    val result = client.startDevice("Pixel", "android")
    assertTrue(result.success)
    assertEquals("emulator-5554", result.deviceId)
  }

  @Test
  fun `readResource returns mapped response`() {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText("automobile:test", """{"key": "value"}""")

    val contents = client.readResource("automobile:test")
    assertEquals(1, contents.size)
    assertEquals("automobile:test", contents[0].uri)
    assertEquals("""{"key": "value"}""", contents[0].text)
  }

  @Test
  fun `readResource returns empty for unknown URI`() {
    val client = FakeAutoMobileClient()

    val contents = client.readResource("automobile:unknown")
    assertTrue(contents.isEmpty())
  }

  @Test
  fun `readResource throws when throwOnReadResource is set`() {
    val client = FakeAutoMobileClient()
    client.throwOnReadResource = McpConnectionException("Connection failed")

    try {
      client.readResource("automobile:test")
      assertTrue("Should have thrown", false)
    } catch (e: McpConnectionException) {
      assertEquals("Connection failed", e.message)
    }
  }

  @Test
  fun `records setKeyValue calls with arguments`() {
    val client = FakeAutoMobileClient()

    client.setKeyValue("device-1", "com.app", "prefs", "key", "value", "STRING")

    val call = client.setKeyValueCalls.single()
    assertEquals("device-1", call.deviceId)
    assertEquals("com.app", call.appId)
    assertEquals("prefs", call.fileName)
    assertEquals("key", call.key)
    assertEquals("value", call.value)
    assertEquals("STRING", call.type)
    assertEquals(listOf("setKeyValue"), client.calls)
  }

  @Test
  fun `records removeKeyValue calls with arguments`() {
    val client = FakeAutoMobileClient()

    client.removeKeyValue("device-1", "com.app", "prefs", "old_key")

    val call = client.removeKeyValueCalls.single()
    assertEquals("device-1", call.deviceId)
    assertEquals("com.app", call.appId)
    assertEquals("prefs", call.fileName)
    assertEquals("old_key", call.key)
  }

  @Test
  fun `records clearKeyValueFile calls with arguments`() {
    val client = FakeAutoMobileClient()

    client.clearKeyValueFile("device-1", "com.app", "prefs")

    val call = client.clearKeyValueFileCalls.single()
    assertEquals("device-1", call.deviceId)
    assertEquals("com.app", call.appId)
    assertEquals("prefs", call.fileName)
  }

  @Test
  fun `records typed input calls with arguments`() {
    val client = FakeAutoMobileClient()

    client.inputTap(x = 10, y = 20, platform = "android", deviceId = "device-1", duration = 50)
    client.inputSwipe(
      startX = 1,
      startY = 2,
      endX = 3,
      endY = 4,
      platform = "ios",
      deviceId = "device-2",
      durationMs = 500,
    )
    client.inputPressButton(button = "back", platform = "android", deviceId = "device-3")
    client.inputTypeText(text = "hello", platform = "ios", deviceId = "device-4", submit = true)
    client.inputKey(key = "enter", platform = "android", deviceId = "device-5")

    assertEquals(
      listOf("inputTap", "inputSwipe", "inputPressButton", "inputTypeText", "inputKey"),
      client.calls,
    )
    assertEquals(
      FakeAutoMobileClient.InputTapCall(
        x = 10,
        y = 20,
        platform = "android",
        deviceId = "device-1",
        duration = 50,
      ),
      client.inputTapCalls.single(),
    )
    assertEquals(
      FakeAutoMobileClient.InputSwipeCall(
        startX = 1,
        startY = 2,
        endX = 3,
        endY = 4,
        platform = "ios",
        deviceId = "device-2",
        durationMs = 500,
      ),
      client.inputSwipeCalls.single(),
    )
    assertEquals(
      FakeAutoMobileClient.InputPressButtonCall(
        button = "back",
        platform = "android",
        deviceId = "device-3",
      ),
      client.inputPressButtonCalls.single(),
    )
    assertEquals(
      FakeAutoMobileClient.InputTypeTextCall(
        text = "hello",
        platform = "ios",
        deviceId = "device-4",
        submit = true,
      ),
      client.inputTypeTextCalls.single(),
    )
    assertEquals(
      FakeAutoMobileClient.InputKeyCall(
        key = "enter",
        platform = "android",
        deviceId = "device-5",
      ),
      client.inputKeyCalls.single(),
    )
  }

  @Test
  fun `returns configurable typed input results`() {
    val client = FakeAutoMobileClient()
    client.inputTapResult =
      InputActionResult(
        action = "input/tap",
        platform = "android",
        deviceId = "device-1",
        success = true,
        coordinates = InputCoordinates(x = 10, y = 20),
      )

    val result = client.inputTap(x = 10, y = 20)

    assertEquals(true, result.success)
    assertEquals("input/tap", result.action)
    assertEquals(InputCoordinates(x = 10, y = 20), result.coordinates)
  }

  @Test
  fun `returns configurable setKeyValue failure`() {
    val client = FakeAutoMobileClient()
    client.setKeyValueResult = SetKeyValueResult(success = false, message = "Write failed")

    val result = client.setKeyValue("d", "a", "f", "k", "v", "STRING")
    assertEquals(false, result.success)
    assertEquals("Write failed", result.message)
  }

  @Test
  fun `callTool records call and returns configured result`() {
    val client = FakeAutoMobileClient()

    client.callTool("observe", JsonObject(emptyMap()))

    assertEquals(listOf("callTool"), client.calls)
  }

  @Test
  fun `defaults return sensible empty values`() {
    val client = FakeAutoMobileClient()

    assertTrue(client.listResources().isEmpty())
    assertTrue(client.listResourceTemplates().isEmpty())
    assertTrue(client.listTools().isEmpty())
    assertTrue(client.listFeatureFlags().isEmpty())
    assertTrue(client.startDevice("name", "android").success)
    assertTrue(client.killDevice("name", "id", "android").success)
    assertTrue(client.setActiveDevice("id", "android").success)
    assertTrue(client.updateService("id", "android").success)
  }
}
