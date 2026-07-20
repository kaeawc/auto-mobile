package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural backstop for issues #3086 and #3992. Enforces that the known seams which emit a
 * correlated `type:"error"` frame on a throw keep delegating to the single
 * [CorrelatedErrorReporter] core instead of hand-rolling it.
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
 *
 * **Scope, and why it stops where it does.** [CorrelatedErrorDriftScanner.CONSUMER_FILES] is a
 * hand-maintained list of the confirmed correlated-error consumers. Widening the scan to every file
 * in the package was considered and rejected: `WebSocketServer.kt` (the decode path, #2985)
 * constructs `ErrorResponse` for legitimate non-fallback reasons, so a package-wide rule would fire
 * on correct code. This is the same limit [BroadcastGuardAdoptionTest] documents for raw
 * `serviceScope.launch` — it "cannot distinguish such an action from the ~30 legitimate raw
 * launches without false positives" — and it is why [ServiceScopeGuard] closed that gap *by
 * construction* rather than by scanning. A text scanner is a backstop against reintroducing a known
 * body, not a proof of absence.
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
          reporter.guarding(null, { "a" }, { "b" }, { "c" }) {}
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
          reporter.guarding(requestId, { "a" }, { "b" }, { "c" }) {}
        }
      }
      """
        .trimIndent()

    // Delegating elsewhere does not excuse constructing a fallback frame by hand.
    assertEquals(
      listOf(CorrelatedErrorDriftScanner.Kind.HAND_ROLLED_ERROR_FRAME),
      scan(source).map { it.kind },
    )
  }

  @Test
  fun `a cause derivation that changes the fallback constant is still flagged`() {
    // The point of drift is that the copy *differs*. Matching only today's literal would miss this.
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        suspend fun guard(e: Exception, requestId: String?) {
          val cause = e.message ?: e::class.simpleName ?: "unspecified failure"
          reporter.guarding(requestId, { "a" }, { "b" }, { "c" }) {}
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
  fun `the Java-interop spellings of the cause rule are flagged too`() {
    // `javaClass.simpleName` is at least as idiomatic in Android code as the Kotlin spelling, so
    // matching only `::class.simpleName` would let the most likely drift through untouched.
    listOf(
        "e.message ?: e.javaClass.simpleName ?: \"boom\"",
        "e.message ?: e::class.java.simpleName ?: \"boom\"",
      )
      .forEach { derivation ->
        val source =
          """
          package dev.jasonpearson.automobile.ctrlproxy

          class Example(private val reporter: CorrelatedErrorReporter) {
            suspend fun guard(e: Exception, requestId: String?) {
              val cause = $derivation
              reporter.guarding(requestId, "a", "b", "c") {}
            }
          }
          """
            .trimIndent()

        assertEquals(
          "must flag: $derivation",
          listOf(CorrelatedErrorDriftScanner.Kind.HAND_ROLLED_CAUSE),
          scan(source).map { it.kind },
        )
      }
  }

  @Test
  fun `renaming the reporter field does not break a correctly delegating consumer`() {
    // A guard that fails CI on a pure rename is a guard that gets deleted.
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val errorReporter: CorrelatedErrorReporter) {
        suspend fun guard(requestId: String?, action: String, block: suspend () -> Unit) {
          errorReporter.guarding(requestId, "a", "b", "c", block)
        }
      }
      """
        .trimIndent()

    assertTrue("a renamed field still delegates: ${scan(source)}", scan(source).isEmpty())
  }

  @Test
  fun `a nested block comment stays fully commented out`() {
    // Kotlin block comments nest. Commenting out an old implementation that carries its own KDoc
    // must not leak the disabled body back into the scan.
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        /* old path, kept for reference:
         /** derives the cause */
         val cause = e.message ?: e::class.simpleName ?: "unknown error"
        */
        suspend fun guard(requestId: String?) = reporter.guarding(requestId, "a", "b", "c") {}
      }
      """
        .trimIndent()

    assertTrue(
      "commented-out code must not be scanned as live: ${scan(source)}",
      scan(source).isEmpty(),
    )
  }

  @Test
  fun `holding a reporter field without ever calling it does not count as delegating`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(broadcast: suspend (ErrorResponse) -> Unit) {
        private val reporter = CorrelatedErrorReporter(broadcast) { _, _ -> }

        suspend fun guard(block: suspend () -> Unit) {
          try {
            block()
          } catch (e: Exception) {
            log(e)
          }
        }
      }
      """
        .trimIndent()

    assertTrue(
      "a field that is never invoked must not satisfy the check: ${scan(source)}",
      scan(source).any { it.kind == CorrelatedErrorDriftScanner.Kind.MISSING_DELEGATION },
    )
  }

  @Test
  fun `a raw string containing a comment opener does not blank the rest of the file`() {
    val source =
      "package dev.jasonpearson.automobile.ctrlproxy\n" +
        "\n" +
        "class Example(private val reporter: CorrelatedErrorReporter) {\n" +
        "  val doc = \"\"\"not a comment: /* still code below */\"\"\"\n" +
        "\n" +
        "  suspend fun guard(requestId: String?) {\n" +
        "    broadcastError(ErrorResponse(requestId = requestId, error = \"boom\"))\n" +
        "    reporter.guarding(requestId, { \"a\" }) {}\n" +
        "  }\n" +
        "}\n"

    assertEquals(
      "code after a raw string must still be scanned",
      listOf(CorrelatedErrorDriftScanner.Kind.HAND_ROLLED_ERROR_FRAME),
      scan(source).map { it.kind },
    )
  }

  @Test
  fun `a char literal holding a quote does not swallow the rest of the line`() {
    val source =
      """
      package dev.jasonpearson.automobile.ctrlproxy

      class Example(private val reporter: CorrelatedErrorReporter) {
        val quote = '"' // the reporter owns the "unknown error" fallback
        suspend fun guard(requestId: String?) = reporter.guarding(requestId) {}
      }
      """
        .trimIndent()

    assertTrue(
      "a trailing comment after a char literal must still be stripped: ${scan(source)}",
      scan(source).isEmpty(),
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
 * The contract is deliberately blunt: within the enumerated [CONSUMER_FILES], the cause derivation
 * and the fallback [ErrorResponse] construction may not appear at all, and each file must both name
 * the core and call it. A blunt contract is what makes it hard to drift past by accident.
 *
 * Note the scope precisely — this is *not* "the cause rule exists in exactly one file in the
 * package". `WebSocketServer.kt` retains a distinct decode-path cause rule that this scanner does
 * not police. See the class KDoc on [CorrelatedErrorDriftGuardTest] for why the scan is targeted.
 */
object CorrelatedErrorDriftScanner {

  /** The single file allowed to contain the correlated-error-on-throw body. */
  const val CORE_FILE = "CorrelatedErrorReporter.kt"

  /** The seams that must delegate to [CORE_FILE] rather than hand-roll the body. */
  val CONSUMER_FILES =
    listOf(
      "ResultBroadcaster.kt",
      "AsyncActionRunner.kt",
      "ServiceScopeGuard.kt",
      "HierarchyExtractErrorFrames.kt",
    )

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
      if (CAUSE_DERIVATION_TOKENS.any { line.contains(it) }) {
        violations += Violation(Kind.HAND_ROLLED_CAUSE, fileName, lineNumber)
      }
      if (line.contains(ERROR_FRAME_CONSTRUCTION)) {
        violations += Violation(Kind.HAND_ROLLED_ERROR_FRAME, fileName, lineNumber)
      }
    }

    val delegates = code.contains(CORE_TYPE) && DELEGATION_CALLS.any { code.contains(it) }
    if (!delegates) {
      violations += Violation(Kind.MISSING_DELEGATION, fileName, 0)
    }

    return violations
  }

  /**
   * Every spelling of the cause rule, not just today's. Drift means the copy *differs*: matching
   * only the literal would miss `?: e::class.simpleName ?: "unspecified failure"`, and matching
   * only `::class.simpleName` would miss the Java-interop spellings that are at least as idiomatic
   * in Android code as the Kotlin one.
   */
  private val CAUSE_DERIVATION_TOKENS =
    listOf(
      "\"unknown error\"",
      "::class.simpleName",
      "::class.java",
      "javaClass.simpleName",
    )

  private const val ERROR_FRAME_CONSTRUCTION = "ErrorResponse("

  /**
   * Delegation must be an actual *call*, not a bare mention of the type: a consumer that holds a
   * `CorrelatedErrorReporter` field, never invokes it, and hand-rolls the body beside it would
   * otherwise satisfy the check by construction. Both halves are required — the type must be named
   * *and* one of these called.
   *
   * Deliberately receiver-agnostic. An earlier version required a literal `reporter.` prefix, which
   * would have failed CI on correct code the moment someone renamed the field to `errorReporter` or
   * wrapped the call in `with(reporter) { … }` — and a test that breaks on a pure rename is a test
   * that gets deleted. `.emit(` is excluded because the package is full of `Flow.emit(` calls
   * (`WebSocketServer`, `HierarchyDebouncer`) that would pass for delegation; `ServiceScopeGuard`
   * qualifies through `causeOf` instead.
   */
  private val DELEGATION_CALLS = listOf(".guarding(", ".causeOf(")

  private const val CORE_TYPE = "CorrelatedErrorReporter"

  /**
   * Blank out `//` line comments and `/* … */` block comments (including KDoc) so prose describing
   * the core is never mistaken for a re-implementation of it. Lines are preserved so reported line
   * numbers still point at the real source.
   *
   * String and character literals are tracked, not stripped — the scanner needs to see the cause
   * constant, which *is* a string literal. Tracking them is what stops a comment opener appearing
   * inside a literal from opening a comment and blanking the real code after it.
   */
  private fun stripComments(source: String): String {
    val out = StringBuilder(source.length)
    // Kotlin block comments nest, so this is a depth counter rather than a flag: commenting out an
    // old implementation that contains its own KDoc must stay fully commented out, or the disabled
    // code gets scanned as live and fails CI on something that isn't even compiled.
    var blockCommentDepth = 0
    var inLineString = false
    var inRawString = false
    var inCharLiteral = false
    var index = 0

    while (index < source.length) {
      val char = source[index]
      val next = source.getOrNull(index + 1)
      val isRawDelimiter = char == '"' && next == '"' && source.getOrNull(index + 2) == '"'

      when {
        blockCommentDepth > 0 -> {
          when {
            char == '/' && next == '*' -> {
              blockCommentDepth++
              index += 2
            }
            char == '*' && next == '/' -> {
              blockCommentDepth--
              index += 2
            }
            else -> {
              if (char == '\n') out.append(char)
              index++
            }
          }
        }
        // A raw string spans lines and honors no escapes; only `"""` closes it.
        inRawString -> {
          if (isRawDelimiter) {
            inRawString = false
            out.append("\"\"\"")
            index += 3
          } else {
            out.append(char)
            index++
          }
        }
        inLineString || inCharLiteral -> {
          when {
            char == '\\' -> {
              out.append(char).append(next ?: ' ')
              index += 2
            }
            // An unterminated literal cannot span a line; recover rather than swallow the file.
            char == '\n' -> {
              inLineString = false
              inCharLiteral = false
              out.append(char)
              index++
            }
            else -> {
              if (inLineString && char == '"') inLineString = false
              if (inCharLiteral && char == '\'') inCharLiteral = false
              out.append(char)
              index++
            }
          }
        }
        char == '/' && next == '*' -> {
          blockCommentDepth++
          index += 2
        }
        char == '/' && next == '/' -> {
          while (index < source.length && source[index] != '\n') index++
        }
        isRawDelimiter -> {
          inRawString = true
          out.append("\"\"\"")
          index += 3
        }
        char == '"' -> {
          inLineString = true
          out.append(char)
          index++
        }
        char == '\'' -> {
          inCharLiteral = true
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
