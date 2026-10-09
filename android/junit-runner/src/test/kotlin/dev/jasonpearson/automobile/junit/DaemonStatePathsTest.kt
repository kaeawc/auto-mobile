package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * #10906: the runner must resolve the same control socket and PID file as the daemon it launches
 * (`resolveDaemonStatePath` in `src/daemon/constants.ts`). Both are tested against the shared
 * vectors in `test/fixtures/daemon-isolation-paths.json`, as are the desktop and XCTestRunner
 * ports.
 */
class DaemonStatePathsTest {
  @Test
  fun `socket and PID paths match the shared daemon vectors`() {
    // The vectors are POSIX paths; on Windows `/tmp/...` is not even absolute.
    assumeTrue(File.separatorChar == '/')
    assertTrue(cases.isNotEmpty())
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val env = case.getValue("env").jsonObject.mapValues { it.value.jsonPrimitive.content }
      // Every vector is absolute or names an absolute launch cwd, so userDir must never be used.
      val userDir = "/never/used"
      assertEquals(
        name,
        case.getValue("suffix").jsonPrimitive.content,
        DaemonStatePaths.isolationSuffix(env::get, userDir),
      )
      assertEquals(
        name,
        case.getValue("socketPath").jsonPrimitive.content,
        DaemonStatePaths.resolve(DaemonStateFile.SOCKET, { uid }, env::get, userDir),
      )
      assertEquals(
        name,
        case.getValue("pidFilePath").jsonPrimitive.content,
        DaemonStatePaths.resolve(DaemonStateFile.PID, { uid }, env::get, userDir),
      )
    }
  }

  @Test
  fun `heartbeat PID path follows the aux-dir isolation suffix`() {
    assumeTrue(File.separatorChar == '/')
    val case = cases.first { it.getValue("name").jsonPrimitive.content == "absolute aux dir" }
    val env = case.getValue("env").jsonObject.mapValues { it.value.jsonPrimitive.content }
    val resolver =
      DaemonUserIdResolver(
        envProvider = env::get,
        osName = { "Linux" },
        userName = { "unused" },
        runCommand = { uid },
      )
    assertEquals(case.getValue("pidFilePath").jsonPrimitive.content, resolver.pidPath())
  }

  @Test
  fun `an explicit override skips the uid lookup`() {
    val path =
      DaemonStatePaths.resolve(
        DaemonStateFile.SOCKET,
        { throw AssertionError("override must not resolve the uid") },
        mapOf("AUTOMOBILE_DAEMON_SOCKET_PATH" to "/run/am.sock")::get,
      )
    assertEquals("/run/am.sock", path)
  }

  private companion object {
    const val RELATIVE_FIXTURE = "test/fixtures/daemon-isolation-paths.json"

    val fixture: JsonObject by lazy {
      val file =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, RELATIVE_FIXTURE) }
          .firstOrNull { it.isFile } ?: error("Could not locate $RELATIVE_FIXTURE")
      Json.parseToJsonElement(file.readText()).jsonObject
    }
    val uid: String by lazy { fixture.getValue("uid").jsonPrimitive.content }
    val cases: List<JsonObject> by lazy {
      fixture.getValue("cases").jsonArray.map { it.jsonObject }
    }
  }
}
