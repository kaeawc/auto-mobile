package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural backstop for issue #3085. Enforces that the "no silent hang for any
 * result-broadcasting handler" guarantee from #3045 / PR #3073 (and the sibling async guarantee
 * from #3023) can't silently regress.
 *
 * The guarantee currently rests entirely on the author having converted every helper by hand:
 * 1. A **new** requestId-correlated `broadcast*Result/Error/Response` helper can forget to route
 *    its body through [ResultBroadcaster.guard] and reintroduce the exact silent-hang bug #3045
 *    fixed.
 * 2. An existing guarded helper (or an [AsyncActionRunner.launch] block) can regress by
 *    reintroducing an inner `try { … } catch (e: Exception) { Log.e(…) }` swallow — the guard only
 *    fires on a throw that *escapes* the block, so a stray inner swallow silently defeats it.
 *
 * This test source-scans [CtrlProxy] and fails CI on either regression. The scanning logic is
 * factored into [BroadcastGuardScanner] (a pure function over source text) so the enforcement
 * contract itself is unit-tested against synthetic good/bad snippets — the real-file assertions
 * then prove the live source complies.
 *
 * Scope: [ResultBroadcaster.guard] adoption is enforced fully (missing guard + reintroduced
 * swallow). [AsyncActionRunner] coverage is the swallow-regression check only — detecting that a
 * brand-new async action forgot `asyncActionRunner.launch` entirely is not structurally feasible
 * without false positives (raw `serviceScope.launch { … }` is used pervasively for legitimate
 * non-action work, e.g. wrapping already-guarded `broadcast*Result` calls), so that is tracked
 * separately per the issue's acceptance criteria.
 */
class BroadcastGuardAdoptionTest {

  // ---------------------------------------------------------------------------
  // Real-source assertions — the live CtrlProxy.kt must comply.
  // ---------------------------------------------------------------------------

  @Test
  fun `every requestId-correlated broadcast helper in CtrlProxy routes through ResultBroadcaster guard`() {
    val result = BroadcastGuardScanner.scan(readCtrlProxySource())

    val missingGuard =
      result.violations.filter { it.kind == BroadcastGuardScanner.Kind.MISSING_GUARD }
    assertTrue(
      "Every `broadcast*Result/Error/Response(requestId: …)` helper must wrap its body in " +
        "`resultBroadcaster.guard(...)` (issue #3045/#3085). Offenders:\n" +
        missingGuard.joinToString("\n") { "  - ${it.symbol} (CtrlProxy.kt:${it.line})" },
      missingGuard.isEmpty(),
    )
  }

  @Test
  fun `no requestId-correlated broadcast helper reintroduces an inner log-and-swallow`() {
    val result = BroadcastGuardScanner.scan(readCtrlProxySource())

    val swallows =
      result.violations.filter { it.kind == BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST }
    assertTrue(
      "A guarded broadcast helper must not reintroduce an inner catch that logs-and-swallows — " +
        "the guard only fires on a throw that escapes the block (issue #3085). Offenders:\n" +
        swallows.joinToString("\n") { "  - ${it.symbol} (CtrlProxy.kt:${it.line})" },
      swallows.isEmpty(),
    )
  }

  @Test
  fun `no asyncActionRunner launch block reintroduces an inner log-and-swallow`() {
    val result = BroadcastGuardScanner.scan(readCtrlProxySource())

    val swallows =
      result.violations.filter { it.kind == BroadcastGuardScanner.Kind.SWALLOW_IN_LAUNCH }
    assertTrue(
      "An `asyncActionRunner.launch { … }` block must not reintroduce an inner catch that " +
        "logs-and-swallows (issue #3023/#3085). Offenders:\n" +
        swallows.joinToString("\n") { "  - ${it.symbol} (CtrlProxy.kt:${it.line})" },
      swallows.isEmpty(),
    )
  }

  @Test
  fun `scanner actually matches the CtrlProxy broadcast helper set`() {
    // Guards against a scanner that silently matches nothing (a broken regex would make every
    // "no violations" assertion vacuously pass). CtrlProxy has 31 such helpers today; assert a
    // conservative lower bound plus a few known members so the check stays meaningful as helpers
    // are added or removed.
    val result = BroadcastGuardScanner.scan(readCtrlProxySource())

    assertTrue(
      "expected the scanner to match the CtrlProxy broadcast helpers, found " +
        "${result.guardedHelpers.size}: ${result.guardedHelpers}",
      result.guardedHelpers.size >= 25,
    )
    for (known in
      listOf(
        "broadcastSetTextResult",
        "broadcastPinchResult",
        "broadcastCurrentFocusError",
        "broadcastClearPreferencesResult",
      )) {
      assertTrue(
        "scanner should have matched $known; matched=${result.guardedHelpers}",
        result.guardedHelpers.contains(known),
      )
    }
    assertTrue(
      "expected the scanner to find asyncActionRunner.launch blocks, found ${result.launchBlocks}",
      result.launchBlocks >= 5,
    )
  }

  // ---------------------------------------------------------------------------
  // Contract tests — prove the scanner catches each regression and does not
  // false-positive on legitimate code. These define the enforcement contract.
  // ---------------------------------------------------------------------------

  @Test
  fun `flags a new broadcast result helper that forgets the guard`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          webSocketServer.broadcast("{\"type\":\"foo_result\"}")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      "the un-guarded helper should be the sole violation",
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a guarded broadcast helper that reintroduces an inner log-and-swallow`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              Log.e(TAG, "Error broadcasting foo result", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // Guard is present, so MISSING_GUARD must NOT fire — the inner swallow is the regression.
    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags an asyncActionRunner launch block that reintroduces an inner log-and-swallow`() {
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(requestId, "screenshot") {
            try {
              takeScreenshotAsync()
            } catch (e: Exception) {
              Log.e(TAG, "screenshot blew up", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_LAUNCH to "asyncActionRunner.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag a push-event broadcaster that legitimately swallows`() {
    // Push events carry no requestId to correlate an error to, so their log-and-swallow is correct
    // and must be left alone. Naming (`*Event` not `*Result/Error/Response`) is the discriminator.
    val src =
      """
      class Fake {
        private suspend fun broadcastNavigationEvent(event: Foo) {
          try {
            webSocketServer.broadcast(event)
          } catch (e: Exception) {
            Log.e(TAG, "Error broadcasting navigation event", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "event broadcasters must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag broadcastNetworkErrorSimulation despite Error appearing mid-name`() {
    // `broadcastNetworkErrorSimulation` contains "Error" mid-name (followed by "Simulation"), is a
    // non-suspend fire-and-forget intent sender, and carries no requestId. It must not be treated
    // as a requestId-correlated result broadcaster.
    val src =
      """
      class Fake {
        private fun broadcastNetworkErrorSimulation(enabled: Boolean) {
          try {
            context.sendBroadcast(intent)
          } catch (e: Exception) {
            Log.e(TAG, "Error simulating network", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "broadcastNetworkErrorSimulation must not be in scope: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertTrue(result.guardedHelpers.isEmpty())
  }

  @Test
  fun `does not flag a launch block that catches to broadcast its own error result`() {
    // AsyncActionRunner's contract: an action that broadcasts a success:false result on its own
    // error path already surfaces the failure and is unaffected — its catch must not be flagged.
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          asyncActionRunner.launch(requestId, "install") {
            try {
              installApp()
            } catch (e: Exception) {
              webSocketServer.broadcast(errorResult(requestId, e.message))
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "a catch that surfaces a broadcast must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag a guarded helper whose only catch rethrows`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              throw e
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "a rethrowing catch surfaces the error: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `flags a swallow whose catch names a throwable local but never rethrows`() {
    // Regression guard for the surface-detection heuristic: a `throwable` local must not be
    // mistaken
    // for a `throw` (rethrow). The catch logs-and-swallows and must still be flagged.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              val throwable = e
              Log.e(TAG, "swallowed", throwable)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag a compliant guarded helper with no catch`() {
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          resultBroadcaster.guard(requestId, "foo_result") {
            webSocketServer.broadcast("payload")
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(listOf("broadcastFooResult"), result.guardedHelpers)
  }

  @Test
  fun `handles raw-string literals containing braces without desyncing brace matching`() {
    // Kotlin raw strings embed unbalanced-looking braces (e.g. `""" {"type":"x"} """`). The scanner
    // must blank literal contents before brace matching or it will mis-slice helper bodies. Build
    // the triple quotes at runtime so this test file itself stays a valid raw string.
    val tq = "\"\"\""
    val src =
      """
      class Fake {
        private suspend fun broadcastFancyResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "fancy_result") {
            webSocketServer.broadcast(buildString { append(${tq}{"type":"fancy","nested":{"a":"b"}}${tq}) })
          }
        }
        private suspend fun broadcastNextResult(requestId: String?) {
          webSocketServer.broadcast("oops")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // The first helper is compliant; the second (un-guarded) must still be detected — proving the
    // brace matcher did not swallow it into the previous body.
    assertEquals(
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastNextResult"),
      result.violations.map { it.kind to it.symbol },
    )
    assertTrue(result.guardedHelpers.contains("broadcastFancyResult"))
  }

  @Test
  fun `flags a NON-suspend direct broadcaster that forgets the guard`() {
    // A requestId-correlated result broadcaster declared `private fun` (not `suspend fun`) must not
    // evade the scan — the existing `broadcastScreenshot` proves non-suspend broadcasters exist.
    val src =
      """
      class Fake {
        private fun broadcastQuickTapResult(requestId: String?, success: Boolean) {
          try {
            webSocketServer.broadcast(buildResult(requestId, success))
          } catch (e: Exception) {
            Log.e(TAG, "Error broadcasting quick tap result", e)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    // The unguarded broadcast is the primary regression; the log-and-swallow is also flagged.
    assertTrue(
      "non-suspend helper must be in scope and flagged unguarded: ${result.violations}",
      result.violations.any {
        it.kind == BroadcastGuardScanner.Kind.MISSING_GUARD &&
          it.symbol == "broadcastQuickTapResult"
      },
    )
    assertTrue(result.guardedHelpers.contains("broadcastQuickTapResult"))
  }

  @Test
  fun `does not flag a NON-suspend broadcaster that delegates to asyncActionRunner launch`() {
    // `broadcastScreenshot`'s real shape: non-suspend, requestId-correlated, delegates the actual
    // broadcast into asyncActionRunner.launch (which is itself swallow-checked). Must pass.
    val src =
      """
      class Fake {
        private fun broadcastScreenshotResult(requestId: String?) {
          asyncActionRunner.launch(requestId, "screenshot") {
            webSocketServer.broadcast(buildScreenshot(requestId))
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "delegating broadcaster must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertTrue(result.guardedHelpers.contains("broadcastScreenshotResult"))
  }

  @Test
  fun `flags a helper that calls guard but performs the broadcast OUTSIDE the guard block`() {
    // A token guard call does not satisfy the guarantee — the throwing broadcast must be *inside*
    // the guard span, or a throw escapes uncaught and the client hangs (issue #3085).
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?, success: Boolean) {
          val message = buildResult(requestId, success)
          webSocketServer.broadcast(message)
          resultBroadcaster.guard(requestId, "foo_ack") { logSomething() }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      "the broadcast sits outside the guard span",
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a swallow that only mentions an unrelated broadcast identifier without a call`() {
    // The surface heuristic must require an actual `broadcast*(` call, not a bare `broadcast`
    // substring — a `broadcastCounter` property read must not launder a log-and-swallow.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              val depth = webSocketServer.broadcastQueueDepth
              Log.e(TAG, "swallowed, depth=", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags a swallow whose catch only re-broadcasts an uncorrelated push event`() {
    // A catch that broadcasts a push event (`broadcast*Event/Update/Change`, no requestId) does not
    // surface a correlated error — the awaiting request still hangs, so it must be flagged (Codex).
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            try {
              webSocketServer.broadcast("payload")
            } catch (e: Exception) {
              broadcastNavigationEvent(currentEvent())
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST to "broadcastFooResult"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `handles string interpolation nesting a string that contains a brace without desyncing`() {
    // `"a ${f("}")}"` is valid, brace-balanced Kotlin, but a masker that ignores ${...} would let
    // the inner quote close the outer string and expose a stray brace, mis-slicing bodies. The
    // following un-guarded helper must still be detected.
    val src =
      """
      class Fake {
        private suspend fun broadcastFooResult(requestId: String?) {
          resultBroadcaster.guard(requestId, "foo_result") {
            val label = "a ${'$'}{describe("}")}"
            webSocketServer.broadcast(label)
          }
        }
        private suspend fun broadcastNextResult(requestId: String?) {
          webSocketServer.broadcast("oops")
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.MISSING_GUARD to "broadcastNextResult"),
      result.violations.map { it.kind to it.symbol },
    )
    assertTrue(result.guardedHelpers.contains("broadcastFooResult"))
  }

  // ---------------------------------------------------------------------------
  // Source location
  // ---------------------------------------------------------------------------

  private fun readCtrlProxySource(): String = locateCtrlProxySource().readText()

  private fun locateCtrlProxySource(): File {
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
 * Pure, Android-free source scanner for the [BroadcastGuardAdoptionTest] enforcement. Reads Kotlin
 * source as text and reports guard-adoption violations. Test-only (lives in the test source set) —
 * ships no scanning code in the app.
 */
object BroadcastGuardScanner {

  enum class Kind {
    /**
     * A requestId-correlated broadcast helper whose body never calls `resultBroadcaster.guard(`.
     */
    MISSING_GUARD,
    /** A requestId-correlated broadcast helper with an inner catch that logs-and-swallows. */
    SWALLOW_IN_BROADCAST,
    /** An `asyncActionRunner.launch { … }` block with an inner catch that logs-and-swallows. */
    SWALLOW_IN_LAUNCH,
  }

  data class Violation(val kind: Kind, val symbol: String, val line: Int)

  data class ScanResult(
    /**
     * Names of requestId-correlated `broadcast*Result/Error/Response` helpers that were matched.
     */
    val guardedHelpers: List<String>,
    /** Count of `asyncActionRunner.launch(...)` blocks that were matched. */
    val launchBlocks: Int,
    val violations: List<Violation>,
  )

  // `suspend` is optional so a non-suspend `private fun broadcast*Result(requestId)` (the shape of
  // the existing `broadcastScreenshot`) can't evade the scan by dropping `suspend`. The naming
  // suffix (Result/Error/Response) + a `requestId` param is the load-bearing discriminator that
  // separates requestId-correlated result broadcasters (must be guarded) from push-event
  // broadcasters (`*Event`/`*Update`/`*Change`, no requestId) that legitimately log-and-swallow.
  private val HELPER = Regex("""(?:suspend )?fun (broadcast\w*(?:Result|Error|Response))\(""")
  private val LAUNCH = Regex("""asyncActionRunner\.launch\(""")
  private val GUARD_CALL = Regex("""resultBroadcaster\.guard\(""")
  private val CATCH = Regex("""catch\s*\(""")
  // The actual result emission. Every such call in a helper must sit *inside* a guard (or launch)
  // block — proving the guard is merely *mentioned* is not enough (a token guard call with the real
  // broadcast outside it would still hang; issue #3085 regression form).
  private val BROADCAST_CALL = Regex("""webSocketServer\.broadcast""")
  // `throw` is word-bounded so a `throwable` local doesn't read as a rethrow.
  private val RETHROW = Regex("""\bthrow\b""")
  // Surfacing requires an actual `broadcast*(` call, not a bare `broadcast` substring — an
  // unrelated
  // `broadcastCounter.foo()` identifier must not launder a swallow …
  private val BROADCAST_CALL_TOKEN = Regex("""broadcast\w*\s*\(""")
  // … and the call must be a *correlated* result/error broadcast, not a push-event broadcaster
  // (`broadcast*Event/Update/Change`, which carries no requestId). A catch that only re-broadcasts
  // an uncorrelated event still leaves the awaiting request to hang, so it must not count as
  // surfaced. `webSocketServer.broadcast(` (token `broadcast(`) is correlated in this context.
  private val EVENT_BROADCAST_TOKEN = Regex("""broadcast\w*(?:Event|Update|Change)\s*\(""")

  fun scan(source: String): ScanResult {
    // `code` masks all string/char literal contents and comments with spaces (newlines preserved)
    // so structural brace/paren matching is not fooled by braces inside `"""{"type":...}"""`.
    val code = maskLiteralsAndComments(source)

    val guardedHelpers = mutableListOf<String>()
    val violations = mutableListOf<Violation>()

    for (m in HELPER.findAll(code)) {
      val name = m.groupValues[1]
      val sigEnd = matchParen(code, m.range.first + m.value.indexOf('(')) // index after ')'
      val signature = code.substring(m.range.first, sigEnd)
      if (!signature.contains("requestId"))
        continue // only requestId-correlated helpers are in scope

      guardedHelpers.add(name)

      val bodyOpen = code.indexOf('{', sigEnd)
      val bodyClose = matchBrace(code, bodyOpen)
      val body = code.substring(bodyOpen, bodyClose)

      // The correlated-error-on-throw guarantee is provided by `resultBroadcaster.guard { … }` (the
      // direct path) or by delegating the broadcast into `asyncActionRunner.launch { … }` (which is
      // itself swallow-checked below). Collect the spans of both.
      val guardedSpans = blockSpans(body, GUARD_CALL) + blockSpans(body, LAUNCH)
      val broadcastCalls = BROADCAST_CALL.findAll(body).map { it.range.first }.toList()
      when {
        guardedSpans.isEmpty() && broadcastCalls.isNotEmpty() ->
          // Broadcasts a result but wraps none of it — the exact "forgot the guard" regression.
          violations.add(
            Violation(Kind.MISSING_GUARD, name, lineOf(source, bodyOpen + broadcastCalls.first()))
          )
        else ->
          // Guard/launch present: every result broadcast must sit *inside* one of those spans. A
          // broadcast outside them is unguarded even though the guard call textually exists.
          for (offset in broadcastCalls) {
            if (guardedSpans.none { offset >= it.first && offset < it.second }) {
              violations.add(Violation(Kind.MISSING_GUARD, name, lineOf(source, bodyOpen + offset)))
            }
          }
      }
      for (offset in swallowingCatchOffsets(body)) {
        violations.add(
          Violation(Kind.SWALLOW_IN_BROADCAST, name, lineOf(source, bodyOpen + offset))
        )
      }
    }

    var launchBlocks = 0
    for (m in LAUNCH.findAll(code)) {
      launchBlocks++
      val parenEnd = matchParen(code, m.range.first + m.value.indexOf('('))
      val blockOpen = code.indexOf('{', parenEnd)
      val blockClose = matchBrace(code, blockOpen)
      val block = code.substring(blockOpen, blockClose)
      for (offset in swallowingCatchOffsets(block)) {
        violations.add(
          Violation(
            Kind.SWALLOW_IN_LAUNCH,
            "asyncActionRunner.launch",
            lineOf(source, blockOpen + offset),
          )
        )
      }
    }

    return ScanResult(guardedHelpers, launchBlocks, violations)
  }

  /**
   * Spans (`[open, close)` of the block `{ … }`) of each call matching [call] found in [region].
   */
  private fun blockSpans(region: String, call: Regex): List<Pair<Int, Int>> {
    val spans = mutableListOf<Pair<Int, Int>>()
    for (m in call.findAll(region)) {
      val parenEnd = matchParen(region, m.range.first + m.value.indexOf('('))
      val blockOpen = region.indexOf('{', parenEnd)
      if (blockOpen < 0) continue
      spans.add(blockOpen to matchBrace(region, blockOpen))
    }
    return spans
  }

  /**
   * Offsets (within [region]) of every `catch (…)` block that "swallows": its body neither rethrows
   * (`throw`) nor surfaces an error frame (an actual `broadcast*(` call). [region] must already be
   * literal-masked so the keyword checks don't match text inside a log message string.
   */
  private fun swallowingCatchOffsets(region: String): List<Int> {
    val offsets = mutableListOf<Int>()
    for (c in CATCH.findAll(region)) {
      val parenEnd = matchParen(region, c.range.first + c.value.indexOf('('))
      val blockOpen = region.indexOf('{', parenEnd)
      if (blockOpen < 0) continue
      val blockClose = matchBrace(region, blockOpen)
      val catchBody = region.substring(blockOpen, blockClose)
      val surfacesViaBroadcast =
        BROADCAST_CALL_TOKEN.findAll(catchBody).any { !EVENT_BROADCAST_TOKEN.matches(it.value) }
      val surfaces = RETHROW.containsMatchIn(catchBody) || surfacesViaBroadcast
      if (!surfaces) offsets.add(c.range.first)
    }
    return offsets
  }

  /** [open] must index a '('; returns the index just past the matching ')'. */
  private fun matchParen(s: String, open: Int): Int {
    var depth = 0
    var i = open
    while (i < s.length) {
      when (s[i]) {
        '(' -> depth++
        ')' -> {
          depth--
          if (depth == 0) return i + 1
        }
      }
      i++
    }
    error("unbalanced parentheses starting at $open")
  }

  /** [open] must index a '{'; returns the index just past the matching '}'. */
  private fun matchBrace(s: String, open: Int): Int {
    var depth = 0
    var i = open
    while (i < s.length) {
      when (s[i]) {
        '{' -> depth++
        '}' -> {
          depth--
          if (depth == 0) return i + 1
        }
      }
      i++
    }
    error("unbalanced braces starting at $open")
  }

  private fun lineOf(source: String, index: Int): Int {
    var line = 1
    var i = 0
    while (i < index && i < source.length) {
      if (source[i] == '\n') line++
      i++
    }
    return line
  }

  /**
   * Replace the contents of every string/char literal and comment with spaces (newlines preserved,
   * so line numbers and length are unchanged), leaving real code structure -- braces, parens,
   * identifiers -- intact so structural matching is not fooled.
   *
   * A stack of lexer states handles the constructs that break a naive scan:
   * - Kotlin raw strings ("\"\"\"...\"\"\"") close on the *last* three quotes of a trailing run.
   * - String-template interpolation "${ ... }" is code, may nest strings that themselves contain
   *   braces/quotes (e.g. `"a ${f("}")}"`), and must not let an inner quote close the outer string.
   *   Interpolation contents are blanked but their braces are balanced (both blanked), so the
   *   surrounding code's brace/paren matching stays correct.
   */
  private fun maskLiteralsAndComments(src: String): String {
    val out = StringBuilder(src.length)
    val n = src.length
    var i = 0
    // Parallel stacks: lexer state + (for INTERP) its running brace depth.
    val states = ArrayDeque<Int>().apply { addLast(CODE) }
    val interpDepth = ArrayDeque<Int>()

    fun blank(count: Int) {
      repeat(count) { out.append(' ') }
    }

    while (i < n) {
      val c = src[i]
      val next = if (i + 1 < n) src[i + 1] else ' '
      when (states.last()) {
        CODE,
        INTERP -> {
          when {
            c == '/' && next == '/' -> {
              states.addLast(LINE_COMMENT)
              blank(2)
              i += 2
            }
            c == '/' && next == '*' -> {
              states.addLast(BLOCK_COMMENT)
              blank(2)
              i += 2
            }
            c == '"' && next == '"' && i + 2 < n && src[i + 2] == '"' -> {
              states.addLast(RAW)
              blank(3)
              i += 3
            }
            c == '"' -> {
              states.addLast(STR)
              blank(1)
              i++
            }
            c == '\'' -> {
              states.addLast(CHAR)
              blank(1)
              i++
            }
            states.last() == INTERP && c == '{' -> {
              interpDepth.addLast(interpDepth.removeLast() + 1)
              blank(1)
              i++
            }
            states.last() == INTERP && c == '}' -> {
              val d = interpDepth.removeLast() - 1
              blank(1)
              i++
              if (d == 0) states.removeLast() else interpDepth.addLast(d)
            }
            states.last() == INTERP -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
            else -> { // CODE: preserve real structure (braces, parens, identifiers).
              out.append(c)
              i++
            }
          }
        }
        STR -> {
          when {
            c == '\\' -> {
              blank(2)
              i += 2
            }
            c == '$' && next == '{' -> {
              states.addLast(INTERP)
              interpDepth.addLast(1)
              blank(2)
              i += 2
            }
            c == '"' -> {
              states.removeLast()
              blank(1)
              i++
            }
            else -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
          }
        }
        RAW -> {
          when {
            c == '$' && next == '{' -> {
              states.addLast(INTERP)
              interpDepth.addLast(1)
              blank(2)
              i += 2
            }
            c == '"' -> {
              var run = 0
              while (i + run < n && src[i + run] == '"') run++
              blank(run)
              i += run
              if (run >= 3) states.removeLast() // last three quotes close the raw string
            }
            else -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
          }
        }
        CHAR -> {
          when {
            c == '\\' -> {
              blank(2)
              i += 2
            }
            c == '\'' -> {
              states.removeLast()
              blank(1)
              i++
            }
            else -> {
              blank(1)
              i++
            }
          }
        }
        LINE_COMMENT -> {
          if (c == '\n') {
            states.removeLast()
            out.append('\n')
          } else {
            blank(1)
          }
          i++
        }
        else -> { // BLOCK_COMMENT
          if (c == '*' && next == '/') {
            states.removeLast()
            blank(2)
            i += 2
          } else {
            out.append(if (c == '\n') '\n' else ' ')
            i++
          }
        }
      }
    }
    return out.toString()
  }

  private const val CODE = 0
  private const val STR = 1 // regular string
  private const val RAW = 2 // raw triple-quoted string
  private const val CHAR = 3 // char literal
  private const val LINE_COMMENT = 4
  private const val BLOCK_COMMENT = 5
  private const val INTERP = 6 // ${ ... } string-template interpolation (code; brace depth tracked)
}
