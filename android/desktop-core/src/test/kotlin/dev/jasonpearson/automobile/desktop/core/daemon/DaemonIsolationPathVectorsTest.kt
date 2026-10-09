package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #10906: the desktop control-socket / PID resolver must agree with the daemon's
 * `resolveDaemonStatePath` (`src/daemon/constants.ts`). Both are tested against the shared vectors
 * in `test/fixtures/daemon-isolation-paths.json`, as are the JUnit runner and XCTestRunner ports.
 */
class DaemonIsolationPathVectorsTest {
  @Test
  fun `control socket and PID paths match the shared daemon vectors`() {
    assertTrue(cases.isNotEmpty())
    // The vectors are POSIX paths; on Windows `/tmp/...` is not even absolute.
    if (File.separatorChar != '/') return
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val env = case.getValue("env").jsonObject.mapValues { it.value.jsonPrimitive.content }
      // Every vector is absolute or names an absolute launch cwd, so userDir must never be used.
      val userDir = "/never/used"
      assertEquals(
        case.getValue("suffix").jsonPrimitive.content,
        AutoMobileSocketPaths.daemonIsolationSuffix(env::get, userDir),
        name,
      )
      assertEquals(
        case.getValue("socketPath").jsonPrimitive.content,
        AutoMobileSocketPaths.daemonStatePath(DaemonStateFile.SOCKET, { uid }, env::get, userDir),
        name,
      )
      assertEquals(
        case.getValue("pidFilePath").jsonPrimitive.content,
        AutoMobileSocketPaths.daemonStatePath(DaemonStateFile.PID, { uid }, env::get, userDir),
        name,
      )
    }
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
