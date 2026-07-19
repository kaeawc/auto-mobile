package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Covers [AppearanceSocketClient] against a real in-process Unix socket. */
class AppearanceSocketClientTest {

  private val configJson =
    """{"syncWithHost": false, "defaultMode": "dark", "applyOnConnect": true}"""

  private fun server(resultJson: String? = null, error: String? = null) =
    TestConfigSocketServer(
      responseType = "appearance_response",
      resultJson = resultJson,
      error = error,
      socketFileName = "appearance.sock",
    )

  @Test
  fun `get_appearance_config sends the documented envelope`() {
    server(resultJson = """{"config": $configJson}""").use { s ->
      AppearanceSocketClient(socketPathValue = s.socketPath.toString()).getConfig()

      val request = s.awaitRequest()
      assertEquals("get_appearance_config", request["command"]?.jsonPrimitive?.content)
      assertEquals("appearance_request", request["type"]?.jsonPrimitive?.content)
    }
  }

  @Test
  fun `set_appearance nests mode under params`() {
    server(resultJson = """{"config": $configJson, "appliedMode": "dark"}""").use { s ->
      AppearanceSocketClient(socketPathValue = s.socketPath.toString())
        .setMode(AppearanceSyncMode.Dark)

      val request = s.awaitRequest()
      assertEquals("set_appearance", request["command"]?.jsonPrimitive?.content)
      assertEquals("dark", request["params"]?.jsonObject?.get("mode")?.jsonPrimitive?.content)
    }
  }

  @Test
  fun `set_appearance_sync nests enabled under params`() {
    server(resultJson = """{"config": $configJson}""").use { s ->
      AppearanceSocketClient(socketPathValue = s.socketPath.toString()).setSyncWithHost(true)

      val request = s.awaitRequest()
      assertEquals("set_appearance_sync", request["command"]?.jsonPrimitive?.content)
      assertEquals(
        "true",
        request["params"]?.jsonObject?.get("enabled")?.jsonPrimitive?.content,
      )
    }
  }

  @Test
  fun `appliedMode is decoded when devices were updated`() {
    server(resultJson = """{"config": $configJson, "appliedMode": "dark"}""").use { s ->
      val result =
        AppearanceSocketClient(socketPathValue = s.socketPath.toString())
          .setMode(AppearanceSyncMode.Dark)

      assertEquals(AppearanceSyncMode.Dark, result.appliedMode)
      assertEquals("dark", result.config.defaultMode)
    }
  }

  @Test
  fun `an omitted appliedMode is null rather than a decode failure`() {
    // The daemon omits appliedMode entirely when no devices are connected to apply to.
    server(resultJson = """{"config": $configJson}""").use { s ->
      val result =
        AppearanceSocketClient(socketPathValue = s.socketPath.toString())
          .setMode(AppearanceSyncMode.Light)

      assertNull(result.appliedMode, "no connected devices means nothing was applied")
      assertEquals("dark", result.config.defaultMode, "the stored config still comes back")
    }
  }

  @Test
  fun `an invalid mode from the daemon degrades to null instead of throwing`() {
    server(resultJson = """{"config": $configJson, "appliedMode": "sepia"}""").use { s ->
      val result = AppearanceSocketClient(socketPathValue = s.socketPath.toString()).getConfig()

      assertNull(result.appliedMode)
    }
  }

  @Test
  fun `a rejected mode surfaces the daemon's message`() {
    server(error = "set_appearance requires mode: light | dark | auto").use { s ->
      val failure =
        assertFailsWith<McpConnectionException> {
          AppearanceSocketClient(socketPathValue = s.socketPath.toString())
            .setMode(AppearanceSyncMode.Auto)
        }

      assertEquals("set_appearance requires mode: light | dark | auto", failure.message)
    }
  }

  @Test
  fun `a missing socket names the path`() {
    val client = AppearanceSocketClient(socketPathValue = "/tmp/no-appearance-am.sock")

    assertTrue(!client.isAvailable())
    val failure = assertFailsWith<McpConnectionException> { client.getConfig() }
    assertTrue(failure.message!!.contains("/tmp/no-appearance-am.sock"))
  }

  @Test
  fun `mode names map case-insensitively and reject unknowns`() {
    assertEquals(AppearanceSyncMode.Dark, AppearanceSyncMode.fromWireName("DARK"))
    assertEquals(AppearanceSyncMode.Auto, AppearanceSyncMode.fromWireName("auto"))
    assertNull(AppearanceSyncMode.fromWireName("sepia"))
    assertNull(AppearanceSyncMode.fromWireName(null))
  }

  @Test
  fun `the fake mirrors the daemon's coupling of mode and host sync`() {
    val client = FakeAppearanceClient()

    // Picking an explicit mode disables host sync; auto re-enables it.
    assertEquals(false, client.setMode(AppearanceSyncMode.Dark).config.syncWithHost)
    assertEquals(true, client.setMode(AppearanceSyncMode.Auto).config.syncWithHost)
  }

  @Test
  fun `the fake reports no applied mode when no devices are connected`() {
    val client = FakeAppearanceClient(hasConnectedDevices = false)

    assertNull(client.setMode(AppearanceSyncMode.Dark).appliedMode)
  }
}
