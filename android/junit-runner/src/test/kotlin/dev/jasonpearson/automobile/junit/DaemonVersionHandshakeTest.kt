package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DaemonVersionHandshakeTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `releaseVersion strips git stamp`() {
    assertEquals("0.0.40", DaemonSocketPaths.releaseVersion("0.0.40+gabc123"))
    assertEquals("0.0.40", DaemonSocketPaths.releaseVersion("0.0.40"))
    assertEquals("", DaemonSocketPaths.releaseVersion(""))
  }

  @Test
  fun `requiresVersionSkewRestart is false when release portions match`() {
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart("0.0.40", "0.0.40"))
    // Source-checkout daemon carries a git stamp; runner declares the plain release.
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart("0.0.40+gabc123", "0.0.40"))
  }

  @Test
  fun `requiresVersionSkewRestart is true when release portions differ`() {
    assertTrue(DaemonSocketPaths.requiresVersionSkewRestart("0.0.41", "0.0.40"))
    assertTrue(DaemonSocketPaths.requiresVersionSkewRestart("0.0.39", "0.0.40"))
  }

  @Test
  fun `requiresVersionSkewRestart is false when either side is unknown`() {
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart(null, "0.0.40"))
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart("0.0.40", null))
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart("", "0.0.40"))
    assertFalse(DaemonSocketPaths.requiresVersionSkewRestart("  ", "0.0.40"))
  }

  @Test
  fun `readDaemonVersionFromPidFile reads version field`() {
    val pidFile = File.createTempFile("automobile-pid", ".pid")
    try {
      pidFile.writeText("""{"pid":123,"port":3000,"version":"0.0.40+gabc123"}""")
      assertEquals("0.0.40+gabc123", DaemonSocketPaths.readDaemonVersionFromPidFile(pidFile.absolutePath))
    } finally {
      pidFile.delete()
    }
  }

  @Test
  fun `readDaemonVersionFromPidFile returns null for missing or malformed files`() {
    assertNull(DaemonSocketPaths.readDaemonVersionFromPidFile("/tmp/does-not-exist-automobile.pid"))

    val malformed = File.createTempFile("automobile-pid-bad", ".pid")
    try {
      malformed.writeText("not json at all")
      assertNull(DaemonSocketPaths.readDaemonVersionFromPidFile(malformed.absolutePath))
    } finally {
      malformed.delete()
    }

    val noVersion = File.createTempFile("automobile-pid-nov", ".pid")
    try {
      noVersion.writeText("""{"pid":123,"port":3000}""")
      assertNull(DaemonSocketPaths.readDaemonVersionFromPidFile(noVersion.absolutePath))
    } finally {
      noVersion.delete()
    }
  }

  @Test
  fun `daemon request serializes clientVersion for the handshake`() {
    val request =
        DaemonRequest(
            id = "req-1",
            type = "mcp_request",
            method = "tools/call",
            params = JsonObject(emptyMap()),
            clientVersion = "0.0.40",
        )
    val encoded = json.encodeToString(request)
    assertTrue("payload should carry clientVersion", encoded.contains("\"clientVersion\":\"0.0.40\""))
  }

  @Test
  fun `shouldForceRestart defaults to false outside CI`() {
    assertFalse(DaemonSocketPaths.shouldForceRestart(null, null, null))
    assertFalse(DaemonSocketPaths.shouldForceRestart("", "", ""))
  }

  @Test
  fun `shouldForceRestart defaults to true in CI when unset`() {
    assertTrue(DaemonSocketPaths.shouldForceRestart(null, null, "true"))
    assertTrue(DaemonSocketPaths.shouldForceRestart(null, null, "1"))
  }

  @Test
  fun `shouldForceRestart honors explicit property over CI`() {
    assertFalse(DaemonSocketPaths.shouldForceRestart("false", null, "true"))
    assertTrue(DaemonSocketPaths.shouldForceRestart("true", null, "false"))
  }

  @Test
  fun `shouldForceRestart honors env when property unset`() {
    assertTrue(DaemonSocketPaths.shouldForceRestart(null, "yes", null))
    assertFalse(DaemonSocketPaths.shouldForceRestart(null, "no", "true"))
  }

  @Test
  fun `daemon request omits clientVersion when null`() {
    val request =
        DaemonRequest(
            id = "req-1",
            type = "mcp_request",
            method = "tools/call",
            params = JsonObject(emptyMap()),
        )
    val encoded = json.encodeToString(request)
    assertFalse("legacy payload should not carry clientVersion", encoded.contains("clientVersion"))
  }
}
