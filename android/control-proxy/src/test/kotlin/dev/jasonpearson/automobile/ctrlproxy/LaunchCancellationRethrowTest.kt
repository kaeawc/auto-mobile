package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural backstop for issue #3130. Enforces that no `serviceScope.launch { … }` / `scope.launch
 * { … }` coroutine in [CtrlProxy] or [WebSocketServer] converts a cooperative
 * [kotlinx.coroutines.CancellationException] into a logged failure/result instead of letting it
 * propagate so the coroutine unwinds cleanly.
 *
 * `CancellationException` **is** a Kotlin `Exception`, so a bare `try { … } catch (e: Exception) {
 * … }` inside a launched coroutine silently swallows the cancellation the runtime throws while the
 * scope is shutting down — the exact anti-pattern that [ResultBroadcaster.guard],
 * [AsyncActionRunner], and the inner `ACTION_EXTRACT_HIERARCHY` branch (PR #3126) all guard against
 * with a `catch (e: CancellationException) { throw e }` clause placed *before* the generic `catch
 * (e: Exception)`. The convention only holds if every launch follows it, so this test source-scans
 * the live files and fails CI on any regression.
 *
 * ## Sibling-receiver audit (issue #3130 AC #2)
 *
 * The `BroadcastReceiver.onReceive` siblings of `commandReceiver` were audited and are
 * intentionally **out of scope** — they cannot swallow a cooperative cancellation:
 * - `navigationEventReceiver`, `recompositionReceiver`, `handledExceptionReceiver`,
 *   `crashReceiver`, `anrReceiver`, `eventBatchReceiver` wrap their parsing in a `try/catch (e:
 *   Exception)` that runs **synchronously in `onReceive`**, not inside a coroutine. No
 *   `serviceScope` job is being cancelled there, so `CancellationException` never arises. Their
 *   inner `serviceScope.launch { … }` dispatches carry **no** inner `try/catch`, so nothing is
 *   swallowed — an uncaught throw is routed to [ServiceScopeGuard]'s `CoroutineExceptionHandler`
 *   (issue #3104) instead.
 * - `packageReceiver` and `screenStateReceiver` likewise launch (or call) with no inner catch.
 *
 * The broad-catch-*inside*-a-launch shape this scanner enforces against was found at three
 * [CtrlProxy] sites (`commandReceiver`, the interaction-event broadcaster, the highlight-response
 * launch) and two [WebSocketServer] sites (`broadcastToClients`' send loop, the `stop()` close
 * launch) — all fixed. The scanning logic is factored into [LaunchCancellationScanner] (a pure
 * function over source text) so the enforcement contract is unit-tested against synthetic good/bad
 * snippets; the real-file assertions then prove the live sources comply.
 *
 * Known limitation (tracked as a follow-up): [LaunchCancellationScanner] treats a broad catch whose
 * body contains *any* `throw` as fully re-surfacing cancellation, so a *conditional* rethrow
 * (`catch (e: Exception) { if (fatal) throw e else log(e) }`) is not flagged even though it
 * swallows cancellation on the non-throwing branch. No such shape exists in the scanned sources
 * today.
 */
class LaunchCancellationRethrowTest {

  // ---------------------------------------------------------------------------
  // Real-source assertions — the live control-proxy sources must comply.
  // ---------------------------------------------------------------------------

  @Test
  fun `no launch block in control-proxy swallows CancellationException`() {
    for (name in SCANNED_SOURCES) {
      val result = LaunchCancellationScanner.scan(locateSource(name).readText())
      assertTrue(
        "Every `serviceScope.launch`/`scope.launch { try { … } catch (e: Exception) }` must " +
          "rethrow `CancellationException` before the generic catch so cooperative cancellation " +
          "unwinds cleanly (issue #3130). Offenders in $name:\n" +
          result.violations.joinToString("\n") { "  - $name:${it.line}" },
        result.violations.isEmpty(),
      )
    }
  }

  @Test
  fun `scanner actually matches the control-proxy launch blocks`() {
    // Guards against a scanner that silently matches nothing (a broken regex would make the
    // "no violations" assertion vacuously pass). CtrlProxy + WebSocketServer launch many
    // coroutines;
    // assert a conservative lower bound on the combined count so the check stays meaningful.
    val total = SCANNED_SOURCES.sumOf {
      LaunchCancellationScanner.scan(locateSource(it).readText()).launchBlocks
    }

    assertTrue("expected the scanner to match many launch blocks, found $total", total >= 15)
  }

  // ---------------------------------------------------------------------------
  // Contract tests — prove the scanner catches the regression and does not
  // false-positive on legitimate code.
  // ---------------------------------------------------------------------------

  @Test
  fun `flags a launch whose broad Exception catch swallows without rethrowing cancellation`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
              sendResult(success = false, error = e.message)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals("the swallowing launch is the sole violation", 1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `flags a launch whose broad Throwable catch swallows without rethrowing cancellation`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (t: Throwable) {
              Log.e(TAG, "boom", t)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
  }

  @Test
  fun `does not flag a launch that rethrows CancellationException before the generic catch`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
              sendResult(success = false, error = e.message)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "compliant launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a launch whose CancellationException is fully qualified`() {
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: kotlinx.coroutines.CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `flags a launch whose CancellationException catch does NOT rethrow`() {
    // A CancellationException catch that logs-and-swallows instead of rethrowing is still the bug —
    // the cooperative cancellation is absorbed and the coroutine does not unwind.
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              Log.e(TAG, "cancelled", e)
            } catch (e: Exception) {
              Log.e(TAG, "Error handling command", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
  }

  @Test
  fun `does not flag a launch with no try catch`() {
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch { broadcastPackageEvent(action, pkg) }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not flag a launch whose only broad catch itself rethrows`() {
    // A `catch (e: Exception) { throw e }` re-surfaces everything including cancellation, so it is
    // not a swallow.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              throw e
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `does not flag an asyncActionRunner launch block (out of scope for this scanner)`() {
    // asyncActionRunner.launch is a different seam covered by BroadcastGuardAdoptionTest; this
    // scanner is scoped to raw serviceScope.launch coroutines only.
    val src =
      """
      class Fake {
        fun dispatch() {
          asyncActionRunner.launch(requestId, "install") {
            try {
              installApp()
            } catch (e: Exception) {
              Log.e(TAG, "boom", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "asyncActionRunner.launch is out of scope: ${result.violations}",
      result.violations.isEmpty(),
    )
    assertEquals("no serviceScope.launch present", 0, result.launchBlocks)
  }

  @Test
  fun `does not desync on a raw string containing braces before an unguarded catch`() {
    // The scanner must blank literal contents before brace matching or it will mis-slice the launch
    // body. Build the triple quotes at runtime so this test file itself stays a valid raw string.
    val tq = "\"\"\""
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            val payload = ${tq}{"type":"cmd","nested":{"a":"b"}}${tq}
            try {
              handle(payload)
            } catch (e: Exception) {
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(
      "the braces in the raw string must not hide the swallow",
      1,
      result.violations.size,
    )
  }

  @Test
  fun `reports one violation per swallowing launch and dedupes by line`() {
    val src =
      """
      class Fake {
        fun a() {
          serviceScope.launch {
            try { x() } catch (e: Exception) { Log.e(TAG, "a", e) }
          }
        }
        fun b() {
          serviceScope.launch {
            try { y() } catch (e: Exception) { Log.e(TAG, "b", e) }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(2, result.violations.size)
    assertEquals(2, result.violations.map { it.line }.toSet().size)
  }

  @Test
  fun `flags a second unrelated swallowing try even when an earlier try rethrows cancellation`() {
    // Per-try precision: a guarded first try must not launder a LATER, separate try/catch that
    // swallows — the exact shape a future edit to commandReceiver would take (the block-level
    // false-negative the reviewers flagged).
    val src =
      """
      class Fake {
        fun onReceive() {
          serviceScope.launch {
            try {
              handleCommand(intent)
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              sendResult(success = false, error = e.message)
            }
            try {
              followUp()
            } catch (e: Exception) {
              Log.e(TAG, "swallowed", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals("only the second, unguarded try is a violation", 1, result.violations.size)
  }

  @Test
  fun `flags a dispatcher-argument launch that swallows`() {
    // `serviceScope.launch(Dispatchers.IO) { … }` must not evade the scan by carrying an argument.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch(Dispatchers.IO) {
            try {
              work()
            } catch (e: Exception) {
              Log.e(TAG, "boom", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `flags a bare scope launch (WebSocketServer form) that swallows`() {
    val src =
      """
      class Fake {
        fun start() {
          scope.launch {
            try {
              connection.close()
            } catch (e: Exception) {
              Log.e(TAG, "closing", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(1, result.violations.size)
    assertEquals(1, result.launchBlocks)
  }

  @Test
  fun `does not count launchIn as a launch block`() {
    // `launchIn(scope)` has no trailing lambda; it must not be miscounted or brace-matched.
    val src =
      """
      class Fake {
        fun collect() {
          flow.onEach { handle(it) }.launchIn(serviceScope)
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertEquals(0, result.launchBlocks)
    assertTrue(result.violations.isEmpty())
  }

  @Test
  fun `KNOWN LIMITATION - a conditionally-rethrowing broad catch is not flagged`() {
    // Pins the documented limitation (see class KDoc): the scanner treats any `throw` in the broad
    // catch body as full re-surfacing, so a conditional rethrow that still swallows cancellation on
    // its non-throwing branch is NOT flagged. No such shape exists in the scanned sources today;
    // this test records the behavior so a future tightening is a deliberate, visible change.
    val src =
      """
      class Fake {
        fun dispatch() {
          serviceScope.launch {
            try {
              work()
            } catch (e: Exception) {
              if (fatal) throw e else Log.e(TAG, "swallowed on non-fatal branch", e)
            }
          }
        }
      }
      """
        .trimIndent()

    val result = LaunchCancellationScanner.scan(src)

    assertTrue(
      "documented false-negative: conditional rethrow not flagged",
      result.violations.isEmpty(),
    )
  }

  // ---------------------------------------------------------------------------
  // Source location
  // ---------------------------------------------------------------------------

  private companion object {
    /** Control-proxy sources scanned by the real-file assertions. */
    val SCANNED_SOURCES = listOf("CtrlProxy.kt", "WebSocketServer.kt")
  }

  private fun locateSource(fileName: String): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/$fileName"
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
    fail("Could not locate $fileName from user.dir=$userDir")
    error("unreachable")
  }
}

/**
 * Pure, Android-free source scanner for [LaunchCancellationRethrowTest]. Reads Kotlin source as
 * text and reports every `serviceScope.launch { … }` / `scope.launch { … }` block that catches the
 * broad `Exception`/`Throwable` supertype without rethrowing
 * [kotlinx.coroutines.CancellationException] in the *same* `try` statement. Test-only (lives in the
 * test source set) — ships no scanning code in the app. Reuses [KotlinSourceScan] for literal
 * masking and structural brace matching.
 *
 * Precision note: the cancellation-rethrow must sit in the **same `try/catch` chain** as the broad
 * catch, not merely somewhere earlier in the launch body. A body-level check would let a guarded
 * `try` launder a *second*, unrelated `try { … } catch (Exception) { … }` that swallows — the exact
 * shape a future edit to `commandReceiver` would take. Catch clauses are grouped into chains by
 * adjacency (only whitespace between one catch's `}` and the next `catch`), which is how Kotlin
 * binds consecutive `catch` clauses to one `try`.
 */
object LaunchCancellationScanner {

  data class Violation(val line: Int)

  data class ScanResult(
    /** Count of `serviceScope.launch { … }` / `scope.launch { … }` blocks that were matched. */
    val launchBlocks: Int,
    val violations: List<Violation>,
  )

  // The coroutine launch forms in scope: `serviceScope.launch` and the WebSocketServer
  // `scope.launch`,
  // with an optional dispatcher argument (`serviceScope.launch(Dispatchers.IO) { … }`). The `{` is
  // located structurally after any balanced argument list, so nested parens don't fool the match.
  private val LAUNCH = Regex("""\b(?:serviceScope|scope)\.launch\b""")
  // Any single-type catch clause; group 1 captures the (possibly qualified) exception type.
  private val ANY_CATCH = Regex("""catch\s*\(\s*\w+\s*:\s*([\w.]+)\s*\)""")
  // `throw` is word-bounded so a `throwable` local doesn't read as a rethrow.
  private val RETHROW = Regex("""\bthrow\b""")

  private data class CatchClause(
    /** Offset (within the launch body) of the `catch` keyword. */
    val start: Int,
    /** Offset just past the catch block's closing `}` (or `start` if it has no block). */
    val blockEnd: Int,
    /** Unqualified exception type name, e.g. `Exception`, `Throwable`, `CancellationException`. */
    val simpleType: String,
    val rethrows: Boolean,
  )

  fun scan(source: String): ScanResult {
    // Mask string/char literals and comments so braces inside them can't mis-slice launch bodies.
    val code = KotlinSourceScan.maskLiteralsAndComments(source)

    val violationLines = sortedSetOf<Int>()
    var launchBlocks = 0

    for (m in LAUNCH.findAll(code)) {
      val blockOpen = launchBlockOpen(code, m.range.last + 1) ?: continue
      launchBlocks++
      val blockClose = KotlinSourceScan.matchBrace(code, blockOpen)
      val body = code.substring(blockOpen, blockClose)

      for (offset in swallowingCatchOffsets(body)) {
        violationLines.add(KotlinSourceScan.lineOf(source, blockOpen + offset))
      }
    }

    return ScanResult(launchBlocks, violationLines.map { Violation(it) })
  }

  /**
   * Given the offset just past a `.launch` token, return the offset of the block's opening `{`,
   * skipping an optional balanced argument list (`(Dispatchers.IO)`). Returns null if what follows
   * is not a trailing-lambda launch (e.g. `launchIn(...)` — no `{`).
   */
  private fun launchBlockOpen(code: String, afterToken: Int): Int? {
    var i = afterToken
    while (i < code.length && code[i].isWhitespace()) i++
    if (i < code.length && code[i] == '(') i = KotlinSourceScan.matchParen(code, i)
    while (i < code.length && code[i].isWhitespace()) i++
    return if (i < code.length && code[i] == '{') i else null
  }

  /**
   * Offsets (within [body]) of every broad `catch (… : Exception|Throwable)` that swallows a
   * cooperative cancellation: it neither rethrows itself nor is preceded, **in the same try/catch
   * chain**, by a `catch (… : CancellationException)` that rethrows.
   */
  private fun swallowingCatchOffsets(body: String): List<Int> {
    val catches =
      ANY_CATCH.findAll(body)
        .map { m ->
          val open = body.indexOf('{', m.range.last)
          val end = if (open < 0) m.range.last else KotlinSourceScan.matchBrace(body, open)
          val rethrows = open >= 0 && RETHROW.containsMatchIn(body.substring(open, end))
          CatchClause(m.range.first, end, m.groupValues[1].substringAfterLast('.'), rethrows)
        }
        .toList()

    val offsets = mutableListOf<Int>()
    for ((idx, c) in catches.withIndex()) {
      if (c.simpleType != "Exception" && c.simpleType != "Throwable") continue
      // A broad catch that itself rethrows re-surfaces cancellation — not a swallow.
      if (c.rethrows) continue
      // Walk back over the contiguous catch chain (only whitespace between clauses) this broad
      // catch
      // belongs to, looking for a rethrowing CancellationException catch bound to the same `try`.
      var guarded = false
      var j = idx - 1
      while (j >= 0 && body.substring(catches[j].blockEnd, catches[j + 1].start).isBlank()) {
        if (catches[j].simpleType == "CancellationException" && catches[j].rethrows) {
          guarded = true
          break
        }
        j--
      }
      if (!guarded) offsets.add(c.start)
    }
    return offsets
  }
}
