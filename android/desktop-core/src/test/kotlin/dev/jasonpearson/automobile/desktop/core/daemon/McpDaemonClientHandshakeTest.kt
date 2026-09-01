package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

class McpDaemonClientHandshakeTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `normalizeClientVersion keeps concrete versions and drops unpinnable aliases`() {
    assertEquals("0.0.40", DaemonSocketPaths.normalizeClientVersion(" 0.0.40 "))
    assertNull(DaemonSocketPaths.normalizeClientVersion("latest"))
    assertNull(DaemonSocketPaths.normalizeClientVersion("UNKNOWN"))
    assertNull(DaemonSocketPaths.normalizeClientVersion("   "))
    assertNull(DaemonSocketPaths.normalizeClientVersion(null))
  }

  @Test
  fun `normalizeClientVersion declares the base release for a Gradle SNAPSHOT dev build`() {
    // A dev-run desktop stamps `<release>-SNAPSHOT`; the daemon gate compares releases and npm has
    // no SNAPSHOT packages, so the base release is what can both match and be installed.
    assertEquals("0.0.67", DaemonSocketPaths.normalizeClientVersion("0.0.67-SNAPSHOT"))
    assertEquals("0.0.67", DaemonSocketPaths.normalizeClientVersion(" 0.0.67-snapshot "))
    // A bare snapshot marker with no release is not a declarable version.
    assertNull(DaemonSocketPaths.normalizeClientVersion("-SNAPSHOT"))
    // Non-SNAPSHOT prereleases stay exact — they may exist as published packages.
    assertEquals("0.0.68-rc.1", DaemonSocketPaths.normalizeClientVersion("0.0.68-rc.1"))
  }

  @Test
  fun `resolveClientVersion falls back after an unpinnable environment alias`() {
    assertEquals(
      "0.0.40",
      DaemonSocketPaths.resolveClientVersion(
        daemonPackageVersion = "latest",
        automobileVersion = "unknown",
        manifestVersion = "0.0.40",
      ),
    )
  }

  @Test
  fun `daemon request serializes clientVersion for the handshake`() {
    val request =
      DaemonRequest(
        id = "req-1",
        type = "mcp_request",
        method = "ide/ping",
        params = JsonObject(emptyMap()),
        clientVersion = "0.0.40",
      )

    val encoded = json.encodeToString(request)

    assertTrue(encoded.contains("\"clientVersion\":\"0.0.40\""))
  }

  @Test
  fun `daemon request omits clientVersion when the desktop build is unknown`() {
    val request =
      DaemonRequest(
        id = "req-1",
        type = "mcp_request",
        method = "ide/ping",
        params = JsonObject(emptyMap()),
      )

    val encoded = json.encodeToString(request)

    assertFalse(encoded.contains("clientVersion"))
  }
}
