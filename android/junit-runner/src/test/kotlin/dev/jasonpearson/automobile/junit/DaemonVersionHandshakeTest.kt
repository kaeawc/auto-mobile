package dev.jasonpearson.automobile.junit

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DaemonVersionHandshakeTest {

  private val json = Json { ignoreUnknownKeys = true }

  private val managedProperties =
      listOf("automobile.daemon.local.project.path", "automobile.daemon.package.version")

  @Before
  fun setUp() {
    managedProperties.forEach { System.clearProperty(it) }
    SystemPropertyCache.clear()
  }

  @After
  fun tearDown() {
    managedProperties.forEach { System.clearProperty(it) }
    SystemPropertyCache.clear()
  }

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
      assertEquals(
          "0.0.40+gabc123",
          DaemonSocketPaths.readDaemonVersionFromPidFile(pidFile.absolutePath),
      )
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
  fun `resolveClientVersion derives local checkout version when local override active`() {
    val projectRoot =
        File.createTempFile("automobile-local", "").let { file ->
          file.delete()
          file.mkdirs()
          file
        }
    try {
      File(projectRoot, "dist/src").mkdirs()
      File(projectRoot, "dist/src/index.js").writeText("// entry")
      File(projectRoot, "package.json")
          .writeText("""{"name":"@kaeawc/auto-mobile","version":"9.9.9"}""")
      System.setProperty("automobile.daemon.local.project.path", projectRoot.absolutePath)
      SystemPropertyCache.clear()

      // The local override starts <local>/dist/src/index.js (version 9.9.9), so the runner must
      // declare 9.9.9 — not the jar Implementation-Version — or the daemon rejects every request.
      assertEquals("9.9.9", DaemonSocketPaths.resolveClientVersion())
    } finally {
      projectRoot.deleteRecursively()
    }
  }

  @Test
  fun `resolveClientVersion omits version when local override lacks a readable package json`() {
    val projectRoot =
        File.createTempFile("automobile-local-nopkg", "").let { file ->
          file.delete()
          file.mkdirs()
          file
        }
    try {
      File(projectRoot, "dist/src").mkdirs()
      File(projectRoot, "dist/src/index.js").writeText("// entry")
      // No package.json → cannot identify the local daemon version → declare nothing (legacy).
      System.setProperty("automobile.daemon.local.project.path", projectRoot.absolutePath)
      SystemPropertyCache.clear()

      assertNull(DaemonSocketPaths.resolveClientVersion())
    } finally {
      projectRoot.deleteRecursively()
    }
  }

  @Test
  fun `resolveClientVersion ignores local override when built daemon entrypoint is absent`() {
    val projectRoot =
        File.createTempFile("automobile-local-nodist", "").let { file ->
          file.delete()
          file.mkdirs()
          file
        }
    try {
      // dist/src/index.js missing → local command is NOT used → fall back to package version path.
      File(projectRoot, "package.json")
          .writeText("""{"name":"@kaeawc/auto-mobile","version":"9.9.9"}""")
      System.setProperty("automobile.daemon.local.project.path", projectRoot.absolutePath)
      SystemPropertyCache.clear()

      // Local override is ignored (no built entrypoint) → falls through to the package-version
      // path, whatever that resolves to in this environment — never the local 9.9.9.
      assertEquals(
          DaemonSocketPaths.resolveDaemonPackageVersion(),
          DaemonSocketPaths.resolveClientVersion(),
      )
    } finally {
      projectRoot.deleteRecursively()
    }
  }

  @Test
  fun `resolveClientVersion returns configured version from system property`() {
    System.setProperty("automobile.daemon.package.version", " 0.0.32 ")
    SystemPropertyCache.clear()
    assertEquals("0.0.32", DaemonSocketPaths.resolveClientVersion())
  }

  @Test
  fun `resolveClientVersion omits ignored alias versions`() {
    System.setProperty("automobile.daemon.package.version", "latest")
    SystemPropertyCache.clear()
    assertNull("latest is not a real version", DaemonSocketPaths.resolveClientVersion())

    System.setProperty("automobile.daemon.package.version", "UNKNOWN")
    SystemPropertyCache.clear()
    assertNull("unknown is not a real version", DaemonSocketPaths.resolveClientVersion())
  }

  @Test
  fun `resolveClientBuildId hashes the local daemon entry script`() {
    val projectRoot =
        File.createTempFile("automobile-local-build", "").let { file ->
          file.delete()
          file.mkdirs()
          file
        }
    try {
      File(projectRoot, "dist/src").mkdirs()
      val entryContent = "// entry contents v1"
      File(projectRoot, "dist/src/index.js").writeText(entryContent)
      System.setProperty("automobile.daemon.local.project.path", projectRoot.absolutePath)
      SystemPropertyCache.clear()

      val expected =
          MessageDigest.getInstance("SHA-256")
              .digest(entryContent.toByteArray())
              .joinToString("") { "%02x".format(it) }
              .substring(0, 16)
      assertEquals(expected, DaemonSocketPaths.resolveClientBuildId())
    } finally {
      projectRoot.deleteRecursively()
    }
  }

  @Test
  fun `resolveClientBuildId is null without a local override`() {
    assertNull(DaemonSocketPaths.resolveClientBuildId())
  }

  @Test
  fun `requiresBuildSkewRestart compares known build ids`() {
    // Both hashes known -> compare hashes (entry scripts irrelevant).
    assertTrue(DaemonSocketPaths.requiresBuildSkewRestart("aaaa1111", "/d.js", "bbbb2222", "/c.js"))
    assertFalse(
        DaemonSocketPaths.requiresBuildSkewRestart("aaaa1111", "/d.js", "aaaa1111", "/c.js")
    )
    assertFalse(DaemonSocketPaths.requiresBuildSkewRestart(null, null, "aaaa1111", "/c.js"))
    assertFalse(DaemonSocketPaths.requiresBuildSkewRestart("aaaa1111", "/d.js", null, null))
  }

  @Test
  fun `requiresBuildSkewRestart falls back to entry script when a hash is unknown`() {
    // Daemon hash unknown but entry scripts recorded on both sides -> compare entry-script paths,
    // mirroring the daemon's buildIdentitiesMatch fallback.
    assertTrue(
        DaemonSocketPaths.requiresBuildSkewRestart(
            "unknown",
            "/other/dist/src/index.js",
            "aaaa1111",
            "/local/dist/src/index.js",
        )
    )
    assertFalse(
        DaemonSocketPaths.requiresBuildSkewRestart(
            "unknown",
            "/local/dist/src/index.js",
            "aaaa1111",
            "/local/dist/src/index.js",
        )
    )
    // Neither hash nor both entry scripts available -> cannot prove skew, no restart.
    assertFalse(
        DaemonSocketPaths.requiresBuildSkewRestart("unknown", null, "aaaa1111", "/local.js")
    )
    assertFalse(
        DaemonSocketPaths.requiresBuildSkewRestart("unknown", "/other.js", "aaaa1111", null)
    )
  }

  @Test
  fun `readDaemonBuildIdFromPidFile reads buildId and entryScript fields`() {
    val pidFile = File.createTempFile("automobile-pid-build", ".pid")
    try {
      pidFile.writeText(
          """{"pid":123,"version":"0.0.40","buildId":"abcdef0123456789","entryScript":"/x/dist/src/index.js"}"""
      )
      assertEquals(
          "abcdef0123456789",
          DaemonSocketPaths.readDaemonBuildIdFromPidFile(pidFile.absolutePath),
      )
      assertEquals(
          "/x/dist/src/index.js",
          DaemonSocketPaths.readDaemonEntryScriptFromPidFile(pidFile.absolutePath),
      )
    } finally {
      pidFile.delete()
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
    assertTrue(
        "payload should carry clientVersion",
        encoded.contains("\"clientVersion\":\"0.0.40\""),
    )
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
