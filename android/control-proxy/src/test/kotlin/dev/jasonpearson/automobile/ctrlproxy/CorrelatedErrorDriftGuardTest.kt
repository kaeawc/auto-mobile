package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural backstop for issue #3086. Enforces that the three seams which emit a correlated
 * `type:"error"` frame on a throw — [ResultBroadcaster], [AsyncActionRunner] and
 * [ServiceScopeGuard] — keep delegating to the single [CorrelatedErrorReporter] core instead of
 * hand-rolling it.
 *
 * #3086 was filed as a deliberate YAGNI defer while only two consumers existed, tracking one
 * specific risk: nothing *forced* the duplicated catch-bodies to stay in lock-step, so a future fix
 * to one (changing the cause derivation, folding the requestId into the message, adjusting
 * cancellation handling) would silently leave the others behind. [ServiceScopeGuard] (#3104) then
 * arrived as the third consumer and duplicated the body a third time, which is the trigger the
 * issue named.
 *
 * Extracting the core removes today's duplication; this scanner is what stops it coming back. The
 * scanning logic is factored into [CorrelatedErrorDriftScanner] (a pure function over source text)
 * so the enforcement contract is itself unit-tested against synthetic good/bad snippets — the
 * real-file assertions then prove the live sources comply.
 */
class CorrelatedErrorDriftGuardTest {

  // ---------------------------------------------------------------------------
  // Contract tests: the scanner itself, over synthetic snippets
  // ---------------------------------------------------------------------------

  @Test
  fun `a consumer that delegates to the reporter is clean`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        suspend fun guard(requestId: String?, action: String, block: suspend () -> Unit) {
          reporter.guarding(requestId, action, "Broadcast failed for", block)
        }
      }
      """
        .trimIndent()

    assertEquals(emptyList<CorrelatedErrorDriftScanner.Violation>(), scan(source))
  }

  @Test
  fun `a hand-rolled cause derivation is flagged`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        suspend fun guard(e: Exception) {
          val cause = e.message ?: e::class.simpleName ?: "unknown error"
          reporter.report(null, cause)
        }
      }
      """
        .trimIndent()

    assertEquals(
      listOf(CorrelatedErrorDriftScanner.Kind.HAND_ROLLED_CAUSE),
      scan(source).map { it.kind },
    )
  }

  @Test
  fun `a hand-rolled error frame construction is flagged`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        suspend fun guard(requestId: String?) {
          broadcastError(ErrorResponse(requestId = requestId, error = "boom"))
        }
      }
      """
        .trimIndent()

    assertEquals(
      listOf(CorrelatedErrorDriftScanner.Kind.HAND_ROLLED_ERROR_FRAME),
      scan(source).map { it.kind },
    )
  }

  @Test
  fun `a consumer that never mentions the reporter is flagged as not delegating`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example {
        suspend fun guard(block: suspend () -> Unit) {
          block()
        }
      }
      """
        .trimIndent()

    assertEquals(
      listOf(CorrelatedErrorDriftScanner.Kind.MISSING_DELEGATION),
      scan(source).map { it.kind },
    )
  }

  @Test
  fun `KDoc and imports naming the frame type are not mistaken for a hand-rolled body`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      import dev.jasonpearson.automobile.protocol.ErrorResponse

      /**
       * Emits a best-effort [ErrorResponse] correlated by requestId. The cause falls back to
       * "unknown error" when the throwable carries no message.
       */
      class Example(private val reporter: CorrelatedErrorReporter) {
        suspend fun guard(requestId: String?, action: String, block: suspend () -> Unit) {
          reporter.guarding(requestId, action, "Broadcast failed for", block)
        }
      }
      """
        .trimIndent()

    assertTrue(
      "comments and imports must not trip the scanner: ${scan(source)}",
      scan(source).isEmpty(),
    )
  }

  @Test
  fun `a line comment mentioning the cause literal is not flagged`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        // The reporter derives the cause, falling back to "unknown error".
        suspend fun guard(requestId: String?, action: String, block: suspend () -> Unit) {
          reporter.guarding(requestId, action, "Broadcast failed for", block)
        }
      }
      """
        .trimIndent()

    assertTrue("line comments must not trip the scanner: ${scan(source)}", scan(source).isEmpty())
  }

  @Test
  fun `the reporter core itself is exempt — it is where the body is allowed to live`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class CorrelatedErrorReporter {
        suspend fun report(requestId: String?, throwable: Throwable) {
          val cause = throwable.message ?: throwable::class.simpleName ?: "unknown error"
          broadcast(ErrorResponse(requestId = requestId, error = cause))
        }
      }
      """
        .trimIndent()

    assertTrue(
      "the core must not flag itself: ${CorrelatedErrorDriftScanner.scan(CorrelatedErrorDriftScanner.CORE_FILE, source)}",
      CorrelatedErrorDriftScanner.scan(CorrelatedErrorDriftScanner.CORE_FILE, source).isEmpty(),
    )
  }

  // ---------------------------------------------------------------------------
  // Real-file assertions: the live sources comply
  // ---------------------------------------------------------------------------

  @Test
  fun `every live consumer delegates to the single correlated-error core`() {
    val violations =
      CorrelatedErrorDriftScanner.CONSUMER_FILES.flatMap { fileName ->
        CorrelatedErrorDriftScanner.scan(fileName, readProductionSource(fileName))
      }

    assertTrue(
      "Correlated-error-on-throw drift detected (issue #3086). Each of " +
        "${CorrelatedErrorDriftScanner.CONSUMER_FILES} must delegate to " +
        "${CorrelatedErrorDriftScanner.CORE_FILE} rather than hand-roll the cause derivation or " +
        "the ErrorResponse fallback: $violations",
      violations.isEmpty(),
    )
  }

  @Test
  fun `the correlated-error core exists as a single file`() {
    val core = locateProductionSource(CorrelatedErrorDriftScanner.CORE_FILE)
    assertTrue("${CorrelatedErrorDriftScanner.CORE_FILE} must exist", core.isFile)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fun scan(source: String): List<CorrelatedErrorDriftScanner.Violation> =
    CorrelatedErrorDriftScanner.scan("Example.kt", source)

  private fun readProductionSource(fileName: String): String =
    locateProductionSource(fileName).readText()

  private fun locateProductionSource(fileName: String): File {
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
 * Pure, Android-free source scanner for the [CorrelatedErrorDriftGuardTest] enforcement. Reads
 * Kotlin source as text and reports correlated-error-core drift. Test-only (lives in the test
 * source set) — ships no scanning code in the app.
 *
 * The contract is deliberately blunt: the cause derivation and the fallback [ErrorResponse]
 * construction may appear in exactly one production file, and every consumer must name the core. A
 * blunt contract is what makes it hard to drift past by accident.
 */
object CorrelatedErrorDriftScanner {

  /** The single file allowed to contain the correlated-error-on-throw body. */
  const val CORE_FILE = "CorrelatedErrorReporter.kt"

  /** The seams that must delegate to [CORE_FILE] rather than hand-roll the body. */
  val CONSUMER_FILES =
    listOf("ResultBroadcaster.kt", "AsyncActionRunner.kt", "ServiceScopeGuard.kt")

  enum class Kind {
    /** The `message ?: simpleName ?: "unknown error"` fallback re-implemented outside the core. */
    HAND_ROLLED_CAUSE,
    /** An `ErrorResponse(…)` fallback frame constructed outside the core. */
    HAND_ROLLED_ERROR_FRAME,
    /** A consumer that never references the core at all. */
    MISSING_DELEGATION,
  }

  data class Violation(val kind: Kind, val file: String, val line: Int)

  /**
   * Scan one Kotlin source file. [fileName] selects the rule set: [CORE_FILE] is exempt (it is
   * where the body is supposed to live); everything else is treated as a consumer.
   */
  fun scan(fileName: String, source: String): List<Violation> {
    if (fileName == CORE_FILE) return emptyList()

    val code = stripComments(source)
    val violations = mutableListOf<Violation>()

    code.lineSequence().forEachIndexed { index, line ->
      val lineNumber = index + 1
      if (line.contains(CAUSE_FALLBACK_LITERAL)) {
        violations += Violation(Kind.HAND_ROLLED_CAUSE, fileName, lineNumber)
      }
      if (line.contains(ERROR_FRAME_CONSTRUCTION)) {
        violations += Violation(Kind.HAND_ROLLED_ERROR_FRAME, fileName, lineNumber)
      }
    }

    if (!code.contains(CORE_TYPE)) {
      violations += Violation(Kind.MISSING_DELEGATION, fileName, 0)
    }

    return violations
  }

  private const val CAUSE_FALLBACK_LITERAL = "\"unknown error\""
  private const val ERROR_FRAME_CONSTRUCTION = "ErrorResponse("
  private const val CORE_TYPE = "CorrelatedErrorReporter"

  /**
   * Blank out `//` line comments and `/* … */` block comments (including KDoc) so prose describing
   * the core is never mistaken for a re-implementation of it. Lines are preserved so reported line
   * numbers still point at the real source.
   */
  private fun stripComments(source: String): String {
    val out = StringBuilder(source.length)
    var inBlockComment = false
    var inString = false
    var index = 0

    while (index < source.length) {
      val char = source[index]
      val next = source.getOrNull(index + 1)

      when {
        char == '\n' -> {
          inString = false
          out.append(char)
          index++
        }
        inBlockComment -> {
          if (char == '*' && next == '/') {
            inBlockComment = false
            index += 2
          } else {
            index++
          }
        }
        inString -> {
          if (char == '\\') {
            out.append(char).append(next ?: ' ')
            index += 2
          } else {
            if (char == '"') inString = false
            out.append(char)
            index++
          }
        }
        char == '/' && next == '*' -> {
          inBlockComment = true
          index += 2
        }
        char == '/' && next == '/' -> {
          while (index < source.length && source[index] != '\n') index++
        }
        char == '"' -> {
          inString = true
          out.append(char)
          index++
        }
        else -> {
          out.append(char)
          index++
        }
      }
    }

    return out.toString()
  }
}
