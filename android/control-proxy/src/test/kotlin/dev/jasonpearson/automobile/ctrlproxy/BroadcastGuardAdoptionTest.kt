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

  private val HELPER = Regex("""suspend fun (broadcast\w*(?:Result|Error|Response))\(""")
  private val LAUNCH = Regex("""asyncActionRunner\.launch\(""")
  private val CATCH = Regex("""catch\s*\(""")
  // `throw` is word-bounded so a `throwable` local doesn't read as a rethrow; any `broadcast*` call
  // (broadcast/broadcastError/broadcastResponse) surfaces the failure, so a bare substring is fine.
  private val RETHROW = Regex("""\bthrow\b""")

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

      if (!body.contains("resultBroadcaster.guard(")) {
        violations.add(Violation(Kind.MISSING_GUARD, name, lineOf(source, m.range.first)))
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
   * Offsets (within [region]) of every `catch (…)` block that "swallows": its body neither rethrows
   * (`throw`) nor surfaces an error frame (`broadcast`). [region] must already be literal-masked so
   * the keyword checks don't match text inside a log message string.
   */
  private fun swallowingCatchOffsets(region: String): List<Int> {
    val offsets = mutableListOf<Int>()
    for (c in CATCH.findAll(region)) {
      val parenEnd = matchParen(region, c.range.first + c.value.indexOf('('))
      val blockOpen = region.indexOf('{', parenEnd)
      if (blockOpen < 0) continue
      val blockClose = matchBrace(region, blockOpen)
      val catchBody = region.substring(blockOpen, blockClose)
      val surfaces = RETHROW.containsMatchIn(catchBody) || catchBody.contains("broadcast")
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
   * so line numbers and length are unchanged), leaving code structure — braces, parens, identifiers
   * — intact. Kotlin raw strings (`"""…"""`) close on the *last* three quotes of a trailing run, so
   * a run of N≥3 quotes contributes N−3 content quotes then closes.
   */
  private fun maskLiteralsAndComments(src: String): String {
    val out = StringBuilder(src.length)
    var i = 0
    val n = src.length

    fun blank(count: Int) {
      repeat(count) { out.append(' ') }
    }

    while (i < n) {
      val c = src[i]
      val next = if (i + 1 < n) src[i + 1] else ' '
      when {
        c == '/' && next == '/' -> {
          while (i < n && src[i] != '\n') {
            out.append(' ')
            i++
          }
        }
        c == '/' && next == '*' -> {
          blank(2)
          i += 2
          while (i < n && !(src[i] == '*' && i + 1 < n && src[i + 1] == '/')) {
            out.append(if (src[i] == '\n') '\n' else ' ')
            i++
          }
          if (i < n) {
            blank(2)
            i += 2
          }
        }
        c == '"' && next == '"' && i + 2 < n && src[i + 2] == '"' -> {
          // Raw string.
          blank(3)
          i += 3
          while (i < n) {
            if (src[i] == '"') {
              var run = 0
              while (i + run < n && src[i + run] == '"') run++
              blank(run)
              i += run
              if (run >= 3) break // last three quotes closed the string
            } else {
              out.append(if (src[i] == '\n') '\n' else ' ')
              i++
            }
          }
        }
        c == '"' -> {
          out.append(' ')
          i++
          while (i < n && src[i] != '"') {
            if (src[i] == '\\') {
              blank(2)
              i += 2
            } else {
              out.append(if (src[i] == '\n') '\n' else ' ')
              i++
            }
          }
          if (i < n) {
            out.append(' ')
            i++
          }
        }
        c == '\'' -> {
          out.append(' ')
          i++
          while (i < n && src[i] != '\'') {
            if (src[i] == '\\') {
              blank(2)
              i += 2
            } else {
              out.append(' ')
              i++
            }
          }
          if (i < n) {
            out.append(' ')
            i++
          }
        }
        else -> {
          out.append(c)
          i++
        }
      }
    }
    return out.toString()
  }
}
