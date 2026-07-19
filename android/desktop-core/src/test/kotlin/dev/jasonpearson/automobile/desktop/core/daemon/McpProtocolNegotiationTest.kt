package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * Covers the `initialize` handshake: the negotiated `protocolVersion` is validated rather than
 * ignored, and `clientInfo` identifies the desktop app with its real build version.
 */
class McpProtocolNegotiationTest {

  private lateinit var daemon: TestDaemonInstance
  private lateinit var client: McpHttpClient

  @Before
  fun setUp() {
    daemon = TestDaemonInstance()
    val port = daemon.start()
    client = McpHttpClient("http://localhost:$port/auto-mobile/streamable")
  }

  @After
  fun tearDown() {
    daemon.stop()
  }

  @Test
  fun `client identifies as the desktop app with a real build version`() {
    client.ping()

    val clientInfo = assertNotNull(daemon.initializeParams)["clientInfo"]?.jsonObject
    assertNotNull(clientInfo)
    assertEquals(DESKTOP_CLIENT_NAME, clientInfo["name"]?.jsonPrimitive?.content)

    val version = clientInfo["version"]?.jsonPrimitive?.content
    assertEquals(DesktopBuildInfo.VERSION, version)
    assertTrue(
      version != "0.1.0" && !version.isNullOrBlank(),
      "clientInfo.version should be the generated build version, was '$version'",
    )
  }

  @Test
  fun `client offers the latest protocol version`() {
    client.ping()

    assertEquals(
      LATEST_MCP_PROTOCOL_VERSION,
      assertNotNull(daemon.initializeParams)["protocolVersion"]?.jsonPrimitive?.content,
    )
  }

  @Test
  fun `an older but supported revision is accepted`() {
    daemon.negotiatedProtocolVersion = "2025-03-26"

    client.ping()

    assertTrue(daemon.calls.contains("initialize"))
  }

  @Test
  fun `an unsupported revision fails with actionable text`() {
    daemon.negotiatedProtocolVersion = "2099-01-01"

    val error = assertFailsWith<McpConnectionException> { client.ping() }

    assertTrue(
      error.message!!.contains("2099-01-01"),
      "Message should name the offending version: ${error.message}",
    )
    assertTrue(
      error.message!!.contains("Update the AutoMobile desktop app"),
      "Message should tell the user what to do: ${error.message}",
    )
  }

  @Test
  fun `a missing protocol version fails rather than silently assuming the latest`() {
    daemon.negotiatedProtocolVersion = null

    val error = assertFailsWith<McpConnectionException> { client.ping() }

    assertTrue(
      error.message!!.contains("omitted protocolVersion"),
      "Message should name the missing field: ${error.message}",
    )
  }

  @Test
  fun `every offered version is one the client also accepts`() {
    assertTrue(LATEST_MCP_PROTOCOL_VERSION in SUPPORTED_MCP_PROTOCOL_VERSIONS)
  }
}
