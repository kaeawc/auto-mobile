package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Production-wiring guard for issue #3042 (follow-up to #3023 / PR #3039).
 *
 * PR #3039 routed CtrlProxy's vulnerable fire-and-forget `serviceScope.launch { … }` action sites
 * through [AsyncActionRunner] so an async throw yields a correlated `type:"error"` frame instead of
 * hanging the daemon awaiter. Its tests fully cover the *helper* ([AsyncActionRunnerTest]) and
 * prove the runner's correlated-error-on-throw contract over a live WebSocket
 * ([WebSocketServerIntegrationTest]). But that integration test wires a *test fake* to a real
 * runner — it never instantiates the production [CtrlProxy] AccessibilityService (heavy
 * `onServiceConnected` init, fixed port 8765). So reverting a production site (e.g.
 * `broadcastScreenshot`) from `asyncActionRunner.launch("screenshot") { … }` back to a bare
 * `serviceScope.launch { … }` — the exact regression #3023 fixes — would leave every existing test
 * green.
 *
 * This test closes that gap with a fast, non-flaky source scan (no Robolectric, no fixed-port I/O)
 * that asserts every request-correlated action the follow-up hardened is still dispatched through
 * `asyncActionRunner.launch(requestId, "<action>")`. Unwiring any one of them drops its action tag
 * and fails CI here.
 *
 * The scanning logic is factored into [AsyncActionRunnerWiringScanner] (a pure function over source
 * text) so the enforcement contract is unit-tested against synthetic wired/unwired snippets; the
 * real-file assertions then prove the live source complies.
 */
class AsyncActionRunnerWiringTest {

  /**
   * The request-correlated action tags PR #3039 routed through [AsyncActionRunner] (issue #3042
   * scope note: broadcastScreenshot, the 8 storage handlers, handleGetPermission,
   * performDeviceInfoRequest, performGlobalActionRequest). Each MUST remain wired; unwiring one
   * reintroduces the silent-hang bug for that action.
   */
  private val REQUIRED_ACTIONS =
    setOf(
      "request_global_action",
      "request_device_info",
      "screenshot",
      "get_permission",
      "list_preference_files",
      "get_preferences",
      "subscribe_storage",
      "unsubscribe_storage",
      "get_preference",
      "set_preference",
      "remove_preference",
      "clear_preferences",
    )

  // ---------------------------------------------------------------------------
  // Real-source assertions — the live CtrlProxy.kt must comply.
  // ---------------------------------------------------------------------------

  @Test
  fun `every required async action stays wired through AsyncActionRunner`() {
    val wired = AsyncActionRunnerWiringScanner.wiredActions(readCtrlProxySource())

    val missing = REQUIRED_ACTIONS - wired
    assertTrue(
      "Every request-correlated action hardened by #3023/#3039 must be dispatched through " +
        "`asyncActionRunner.launch(requestId, \"<action>\")` so an async throw yields a correlated " +
        "`type:\"error\"` frame instead of hanging the daemon awaiter. Unwired (reverted to a bare " +
        "`serviceScope.launch`?) actions:\n" +
        missing.sorted().joinToString("\n") { "  - $it" },
      missing.isEmpty(),
    )
  }

  @Test
  fun `scanner actually matches the CtrlProxy async action set`() {
    // Guards against a scanner that silently matches nothing (a broken regex would make the "no
    // missing actions" assertion vacuously pass).
    val wired = AsyncActionRunnerWiringScanner.wiredActions(readCtrlProxySource())

    assertTrue(
      "expected the scanner to match the CtrlProxy async action tags, found $wired",
      wired.size >= REQUIRED_ACTIONS.size,
    )
    assertTrue(
      "scanner should have matched the screenshot dispatch; matched=$wired",
      wired.contains("screenshot"),
    )
  }

  // ---------------------------------------------------------------------------
  // Contract tests — prove the scanner catches the regression and does not
  // false-positive. These define the enforcement contract.
  // ---------------------------------------------------------------------------

  @Test
  fun `wiredActions extracts the action tag from a launch call`() {
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(requestId, "screenshot") {
            takeScreenshotAsync()
          }
        }
      }
      """
        .trimIndent()

    assertEquals(setOf("screenshot"), AsyncActionRunnerWiringScanner.wiredActions(src))
  }

  @Test
  fun `wiredActions does NOT count a site reverted to a bare serviceScope launch`() {
    // The exact #3023 regression: the screenshot dispatch loses its AsyncActionRunner wiring. Its
    // action tag must disappear so the real-source assertion fails.
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          serviceScope.launch(RequestIdContext(requestId)) {
            takeScreenshotAsync()
          }
        }
      }
      """
        .trimIndent()

    assertTrue(
      "a bare serviceScope.launch must not register any AsyncActionRunner action tag",
      AsyncActionRunnerWiringScanner.wiredActions(src).isEmpty(),
    )
  }

  @Test
  fun `wiredActions collects multiple distinct action tags`() {
    val src =
      """
      class Fake {
        private fun a(requestId: String?) {
          asyncActionRunner.launch(requestId, "get_preference") { readPref() }
        }
        private fun b(requestId: String?) {
          asyncActionRunner.launch(requestId, "set_preference") { writePref() }
        }
      }
      """
        .trimIndent()

    assertEquals(
      setOf("get_preference", "set_preference"),
      AsyncActionRunnerWiringScanner.wiredActions(src),
    )
  }

  @Test
  fun `wiredActions ignores an action tag that only appears inside a string literal`() {
    // A masker desync would let a `"screenshot"` mentioned in a log message masquerade as a real
    // dispatch. The launch here uses a different tag; only that tag must be collected.
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          Log.d(TAG, "about to launch screenshot for asyncActionRunner.launch")
          asyncActionRunner.launch(requestId, "get_permission") { resolve() }
        }
      }
      """
        .trimIndent()

    assertEquals(setOf("get_permission"), AsyncActionRunnerWiringScanner.wiredActions(src))
  }

  @Test
  fun `wiredActions tolerates whitespace and newlines around the action argument`() {
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(
            requestId,
            "clear_preferences",
          ) {
            clearAll()
          }
        }
      }
      """
        .trimIndent()

    assertEquals(setOf("clear_preferences"), AsyncActionRunnerWiringScanner.wiredActions(src))
  }

  // ---------------------------------------------------------------------------
  // Source location
  // ---------------------------------------------------------------------------

  private fun readCtrlProxySource(): String = locateCtrlProxySource().readText()

  private fun locateCtrlProxySource(): File {
    // Forward slashes only: paths are compared/joined below and this test also runs on Windows CI.
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    // Depending on the Gradle working directory the module root may be the cwd (AGP unit tests),
    // the `android` dir, or the repo root. Try the common anchors, then walk up as a fallback.
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull {
          it.isFile
        }
    if (direct != null) return direct

    val userDir = System.getProperty("user.dir") ?: "."
    var dir: File? = File(userDir).absoluteFile
    while (dir != null) {
      for (candidate in
        listOf(
          File(dir, rel),
          File(dir, "control-proxy/$rel"),
          File(dir, "android/control-proxy/$rel"),
        )) {
        if (candidate.isFile) return candidate
      }
      dir = dir.parentFile
    }
    fail("Could not locate CtrlProxy.kt from user.dir=$userDir")
    error("unreachable")
  }
}

/**
 * Pure, Android-free source scanner for [AsyncActionRunnerWiringTest]. Reads Kotlin source as text
 * and reports the set of action tags dispatched through `asyncActionRunner.launch(requestId,
 * "<action>")`. Test-only (lives in the test source set) — ships no scanning code in the app.
 *
 * It reuses [KotlinSourceScan.maskLiteralsAndComments] to blank comment/literal contents so a
 * `"screenshot"` inside a log message can't masquerade as a real dispatch, then re-reads the tag
 * from the *original* source at the same offset (the masked copy blanks literal contents).
 */
object AsyncActionRunnerWiringScanner {

  private val LAUNCH = Regex("""asyncActionRunner\.launch\(""")
  // The action tag is the second positional argument: `launch(<requestId>, "<action>")`.
  private val ACTION_ARG = Regex("""^\s*[^,]+,\s*"([a-z_]+)"""")

  fun wiredActions(source: String): Set<String> {
    val code = KotlinSourceScan.maskLiteralsAndComments(source)
    val actions = mutableSetOf<String>()
    for (m in LAUNCH.findAll(code)) {
      val openParen = m.range.first + m.value.indexOf('(')
      val closeParen = KotlinSourceScan.matchParen(code, openParen) // index just past ')'
      // Read the arg list from the ORIGINAL source: the masked copy has blanked the "<action>"
      // literal, so its tag characters are gone. Offsets are identical (masking preserves length).
      val args = source.substring(openParen + 1, closeParen - 1)
      ACTION_ARG.find(args)?.let { actions.add(it.groupValues[1]) }
    }
    return actions
  }
}
