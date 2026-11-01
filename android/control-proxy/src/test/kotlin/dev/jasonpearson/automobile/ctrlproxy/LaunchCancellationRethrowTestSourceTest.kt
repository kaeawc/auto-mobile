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
 * The broad-catch-*inside*-a-coroutine shape this scanner enforces against was found at three
 * [CtrlProxy] sites (`commandReceiver`, the interaction-event broadcaster, the highlight-response
 * launch) and three [WebSocketServer] sites (`broadcastToClients`' send loop, the `stop()` close
 * launch, and the `webSocket("/ws")` read-loop handler whose outer catch re-swallowed the
 * cancellation `handleClientMessage` rethrows) — all fixed. The scanner covers
 * `serviceScope.launch` / `scope.launch` builders, Ktor `webSocket { … }` route handlers, and —
 * since issue #3191 — **every** named `suspend fun` in the scanned files, auto-discovered rather
 * than manually curated (a new suspend helper is scanned by default; `exemptSuspendFns` is the
 * explicit opt-out for a broad catch that provably wraps only synchronous code). The scanning logic
 * is factored into [LaunchCancellationScanner] (a pure function over source text) so the
 * enforcement contract is unit-tested against synthetic good/bad snippets; the real-file assertions
 * then prove the live sources comply.
 *
 * A broad catch counts as re-surfacing cancellation only when its **last top-level statement is a
 * `throw`** (issue #3192): `cleanup(); throw wrap(e)` complies, while a *conditional* rethrow
 * (`catch (e: Exception) { if (fatal) throw e else log(e) }`) is flagged because the non-throwing
 * branch still swallows the cancellation.
 */
internal class LaunchCancellationRethrowTestSourceTest {
  // ---------------------------------------------------------------------------
  // Real-source assertions — the live control-proxy sources must comply.
  // ---------------------------------------------------------------------------

  @Test
  fun `no coroutine body in control-proxy swallows CancellationException`() {
    for (src in SCANNED_SOURCES) {
      val result =
        LaunchCancellationScanner.scan(locateSource(src.fileName).readText(), src.exemptSuspendFns)
      assertTrue(
        "Every `serviceScope.launch`/`scope.launch`/`webSocket { … }` coroutine body and every " +
          "auto-discovered `suspend fun` must rethrow `CancellationException` before the generic " +
          "catch so cooperative cancellation unwinds cleanly (issues #3130/#3191). Add a `catch " +
          "(e: CancellationException) { throw e }` clause, or — only if the broad catch provably " +
          "wraps synchronous code — an `exemptSuspendFns` entry with a justification. " +
          "Offenders in ${src.fileName}:\n" +
          result.violations.joinToString("\n") { "  - ${src.fileName}:${it.line}" },
        result.violations.isEmpty(),
      )
    }
  }

  @Test
  fun `controller action bodies remain covered after extraction`() {
    val source = locateSource("CaCertificateController.kt").readText()
    val result = LaunchCancellationScanner.scan(source)

    // Four actions, the removal operation, and two broadcast helpers; the sender is bodyless.
    assertEquals(7, result.launchBlocks)
    val code = KotlinSourceScan.maskLiteralsAndComments(source)
    val declaration = code.indexOf("suspend fun performRemoveCaCertificate(")
    assertTrue(declaration >= 0)
    val paramsOpen = code.indexOf('(', declaration)
    val paramsEnd = KotlinSourceScan.matchParen(code, paramsOpen)
    val bodyOpen = code.indexOf('{', paramsEnd)
    val body = code.substring(bodyOpen, KotlinSourceScan.matchBrace(code, bodyOpen))
    assertTrue(
      body
        .replace(Regex("\\s+"), "")
        .contains("RemoveCertificate(alias,certificate).run(requestId,startTime)"),
    )
    assertActionsUseFailureHelper(
      source,
      "withCaPolicyFailures",
      "performInstallCaCertificate",
      "run",
    )
  }

  @Test
  fun `settings controller action bodies remain covered after extraction`() {
    val source = locateSource("SettingsController.kt").readText()
    val result = LaunchCancellationScanner.scan(source)

    assertEquals(6, result.launchBlocks)
    assertActionsUseFailureHelper(
      source,
      "withSettingsFailures",
      "performSettingsRead",
      "performSettingsWrite",
      "performSettingsList",
    )
  }

  @Test
  fun `package controller action bodies remain covered after extraction`() {
    val source = locateSource("PackageController.kt").readText()
    val result = LaunchCancellationScanner.scan(source)

    // Three actions, three broadcasts, and the extracted package metadata reader.
    assertEquals(7, result.launchBlocks)
    assertActionsUseFailureHelper(
      source,
      "withPackageFailures",
      "performInstalledPackages",
      "performPackageInfo",
      "performLaunchIntent",
    )
  }

  private fun assertActionsUseFailureHelper(
    source: String,
    helperName: String,
    vararg actionNames: String,
  ) {
    val code = KotlinSourceScan.maskLiteralsAndComments(source)
    for (actionName in actionNames) {
      val declaration = code.indexOf("suspend fun $actionName(")
      assertTrue("$actionName must remain a scanned suspend action", declaration >= 0)
      val paramsOpen = code.indexOf('(', declaration)
      val paramsEnd = KotlinSourceScan.matchParen(code, paramsOpen)
      val bodyOpen = code.indexOf('{', paramsEnd)
      val body = code.substring(bodyOpen, KotlinSourceScan.matchBrace(code, bodyOpen))
      assertEquals(
        "$actionName must route its platform work through $helperName",
        1,
        Regex("\\b$helperName\\s*\\(").findAll(body).count(),
      )
    }
    assertFailureHelperRethrowsCancellation(source, helperName)
  }

  private fun assertFailureHelperRethrowsCancellation(source: String, helperName: String) {
    val declaration = source.indexOf("private inline fun <T> $helperName(")
    check(declaration >= 0) { "$helperName not found" }
    val expression = source.indexOf("=\n", declaration)
    check(expression >= 0) { "$helperName expression body not found" }
    // These final, inline helpers execute in their caller's coroutine. Exercise their actual catch
    // clauses with the scanner's broad-catch model: IllegalStateException also includes
    // cancellation.
    val body = source.substring(expression + 1).replace("IllegalStateException", "Exception")
    val coroutine = "scope.launch { $body }"
    assertTrue(LaunchCancellationScanner.scan(coroutine).violations.isEmpty())
    assertEquals(
      "removing the helper's cancellation rethrow must expose a swallowing catch",
      1,
      LaunchCancellationScanner.scan(coroutine.replace("throw e", "Unit")).violations.size,
    )
  }

  @Test
  fun `scanner actually matches the control-proxy coroutine bodies`() {
    // Guards against a scanner that silently matches nothing (a broken regex would make the
    // "no violations" assertion vacuously pass). CtrlProxy + WebSocketServer launch many
    // coroutines; assert a conservative lower bound on the combined count so it stays meaningful.
    val total = SCANNED_SOURCES.sumOf {
      LaunchCancellationScanner.scan(locateSource(it.fileName).readText(), it.exemptSuspendFns)
        .launchBlocks
    }

    // Conservative floor: guards against a broken regex (→ 0) without being brittle to how many
    // launch sites the sources happen to have as they are refactored. The floor is high enough
    // (40) that it can only be met when suspend-fn auto-discovery (#3191) works too — CtrlProxy
    // alone declares ~50 suspend helpers, while launch/webSocket blocks number ~15.
    assertTrue("expected the scanner to match many coroutine bodies, found $total", total >= 40)
  }

  // ---------------------------------------------------------------------------
  // Source location
  // ---------------------------------------------------------------------------

  private companion object {
    /**
     * Control-proxy sources scanned by the real-file assertions. Every named `suspend fun` in these
     * files is auto-discovered and scanned (issue #3191); `exemptSuspendFns` is the explicit
     * opt-out for a fn whose broad catch provably wraps only synchronous code. Keep it empty unless
     * a rethrow clause is genuinely wrong — a stale entry fails the scan loudly.
     */
    val SCANNED_SOURCES =
      listOf(
        ScannedSource("CtrlProxy.kt", exemptSuspendFns = emptyList()),
        ScannedSource("CtrlProxyActionRouter.kt", exemptSuspendFns = emptyList()),
        ScannedSource("CaCertificateController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("SettingsController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("PackageController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("StorageController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("ClipboardController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("FocusController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("TextInputController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("GestureController.kt", exemptSuspendFns = emptyList()),
        ScannedSource("FailureReceivers.kt", exemptSuspendFns = emptyList()),
        ScannedSource("PackageScreenReceivers.kt", exemptSuspendFns = emptyList()),
        ScannedSource("CommandReceivers.kt", exemptSuspendFns = emptyList()),
        ScannedSource("WebSocketServer.kt", exemptSuspendFns = emptyList()),
        ScannedSource("DeviceEventBroadcaster.kt", exemptSuspendFns = emptyList()),
        ScannedSource("ScreenshotRequestHandler.kt", exemptSuspendFns = emptyList()),
        ScannedSource("FrameContextGate.kt", exemptSuspendFns = emptyList()),
        ScannedSource("HierarchyExtractCommandHandler.kt", exemptSuspendFns = emptyList()),
      )
  }

  private data class ScannedSource(val fileName: String, val exemptSuspendFns: List<String>)

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
 * Pure, Android-free source scanner for [LaunchCancellationRethrowTestSourceTest]. Reads Kotlin
 * source as text and reports every **coroutine body** that catches the broad
 * `Exception`/`Throwable` supertype without rethrowing [kotlinx.coroutines.CancellationException]
 * in the *same* `try` statement. Test-only (lives in the test source set) — ships no scanning code
 * in the app. Reuses [KotlinSourceScan] for literal masking and structural brace matching.
 *
 * Coroutine bodies scanned:
 * - `serviceScope.launch { … }` / `scope.launch { … }` builders (optionally with a dispatcher
 *   argument, `launch(Dispatchers.IO) { … }`).
 * - Ktor `webSocket(…) { … }` route handlers — the read loop is itself a coroutine whose outer
 *   catch can re-swallow a cancellation that an inline suspend call (`handleClientMessage`)
 *   rethrows (issue #3130 review follow-up).
 * - Every named `suspend fun` in the source, **auto-discovered** (issue #3191) — a broad catch in a
 *   suspend body can swallow the cancellation of whatever coroutine calls it (the
 *   `broadcastToClients` shape). Text cannot prove the catch's `try` wraps a suspend call, so the
 *   rule is opt-out: a fn whose broad catch provably wraps only synchronous code may be named in
 *   [scan]'s `exemptSuspendFns`; a stale exemption fails loudly.
 *
 * Precision note: the cancellation-rethrow must sit in the **same `try/catch` chain** as the broad
 * catch, not merely somewhere earlier in the body. A body-level check would let a guarded `try`
 * launder a *second*, unrelated `try { … } catch (Exception) { … }` that swallows — the exact shape
 * a future edit to `commandReceiver` would take. Catch clauses are grouped into chains by adjacency
 * (only whitespace between one catch's `}` and the next `catch`), which is how Kotlin binds
 * consecutive `catch` clauses to one `try`.
 *
 * Rethrow tightness (issue #3192): a catch body re-surfaces cancellation only when its **last
 * top-level statement is a `throw`** and no earlier top-level statement is a
 * `return`/`break`/`continue` that could bypass it. `cleanup(); throw wrap(e)` complies; `if
 * (fatal) throw e else log(e)`, a throw nested in a `when` branch or lambda, and `if (retry)
 * return` before a final throw do not. Nested `{…}`/`(…)` groups are blanked before statement
 * splitting so multi-line arguments and lambda bodies cannot fool the check.
 */
internal object LaunchCancellationScanner {

  data class Violation(val line: Int)

  data class ScanResult(
    /** Count of coroutine bodies (launch/webSocket/guarded-suspend) that were matched. */
    val launchBlocks: Int,
    val violations: List<Violation>,
  )

  // Coroutine-body openers: `serviceScope.launch` / `scope.launch` builders and Ktor `webSocket`
  // route handlers. The opening `{` is located structurally after any balanced argument list
  // (`(Dispatchers.IO)`, `("/ws")`), so nested parens don't fool the match. `\bwebSocket\b` matches
  // the lowercase route-builder call, not the `WebSockets` plugin or a `webSocketServer` field.
  private val COROUTINE_BUILDER = Regex("""\b(?:serviceScope|scope)\.launch\b|\bwebSocket\b""")
  // Any single-type catch clause; group 1 captures the (possibly qualified) exception type.
  private val ANY_CATCH = Regex("""catch\s*\(\s*\w+\s*:\s*([\w.]+)\s*\)""")
  // Named `suspend fun` declaration. Modifiers before `suspend` are irrelevant to the match;
  // modifiers between (`suspend inline fun`), simple generics (`fun <T> f(`), and a dotted
  // extension receiver (`fun Foo.bar(`) are tolerated so such fns can't evade discovery. Group 1
  // captures the fn name, and the trailing `\(` anchors matchParen on the parameter list.
  private val SUSPEND_FN_DECL =
    Regex("""\bsuspend\s+(?:\w+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(""")
  // `throw` is word-bounded so a `throwable` local doesn't read as a rethrow.
  private val RETHROW_STATEMENT = Regex("""^throw\b""")
  // A top-level statement that exits the catch without throwing bypasses a later final throw.
  private val EARLY_EXIT = Regex("""\breturn\b|\bbreak\b|\bcontinue\b""")

  private data class CatchClause(
    /** Offset (within the coroutine body) of the `catch` keyword. */
    val start: Int,
    /** Offset just past the catch block's closing `}` (or `start` if it has no block). */
    val blockEnd: Int,
    /** Unqualified exception type name, e.g. `Exception`, `Throwable`, `CancellationException`. */
    val simpleType: String,
    val rethrows: Boolean,
  )

  /**
   * Scan [source]. Every named `suspend fun` in the source is auto-discovered and scanned
   * (issue #3191) unless named in [exemptSuspendFns] — the explicit opt-out for a fn whose broad
   * catch provably wraps only synchronous code. An exemption naming a fn that no longer exists
   * fails loudly so the list cannot rot.
   *
   * A launch/webSocket block nested inside a suspend fn is scanned under both passes; violation
   * lines are deduplicated, [launchBlocks][ScanResult.launchBlocks] counts both bodies.
   */
  fun scan(source: String, exemptSuspendFns: List<String> = emptyList()): ScanResult {
    // Mask string/char literals and comments so braces inside them can't mis-slice bodies.
    val code = KotlinSourceScan.maskLiteralsAndComments(source)

    val violationLines = sortedSetOf<Int>()
    var launchBlocks = 0

    for (m in COROUTINE_BUILDER.findAll(code)) {
      val blockOpen = trailingLambdaOpen(code, m.range.last + 1) ?: continue
      launchBlocks++
      val blockClose = KotlinSourceScan.matchBrace(code, blockOpen)
      val body = code.substring(blockOpen, blockClose)
      for (offset in swallowingCatchOffsets(body)) {
        violationLines.add(KotlinSourceScan.lineOf(source, blockOpen + offset))
      }
    }

    val discovered = mutableSetOf<String>()
    for (decl in SUSPEND_FN_DECL.findAll(code)) {
      val name = decl.groupValues[1]
      discovered.add(name)
      if (name in exemptSuspendFns) continue
      val sigEnd = KotlinSourceScan.matchParen(code, decl.range.last)
      val blockOpen = suspendFnBodyOpen(code, sigEnd) ?: continue
      launchBlocks++
      val blockClose = KotlinSourceScan.matchBrace(code, blockOpen)
      val body = code.substring(blockOpen, blockClose)
      for (offset in swallowingCatchOffsets(body)) {
        violationLines.add(KotlinSourceScan.lineOf(source, blockOpen + offset))
      }
    }
    val stale = exemptSuspendFns.filterNot { it in discovered }
    if (stale.isNotEmpty()) {
      fail("stale exemptSuspendFns entries not declared in source: $stale")
    }

    return ScanResult(launchBlocks, violationLines.map { Violation(it) })
  }

  /**
   * Offset of the body's opening `{` for a suspend fn whose parameter list ends just before
   * [sigEnd], or null for a bodyless declaration (interface/abstract or a brace-less expression
   * body) — the next `{` in the file would belong to a *different* declaration and must not be
   * mis-sliced. The text between the signature and a genuine body brace is only the return type
   * and/or an `=` expression prefix, so running into a `}` or another `fun` keyword means there is
   * no body.
   */
  private fun suspendFnBodyOpen(code: String, sigEnd: Int): Int? {
    val blockOpen = code.indexOf('{', sigEnd)
    if (blockOpen < 0) return null
    val between = code.substring(sigEnd, blockOpen)
    if (between.contains('}') || Regex("""\bfun\b""").containsMatchIn(between)) return null
    return blockOpen
  }

  /**
   * Given the offset just past a coroutine-builder token, return the offset of the block's opening
   * `{`, skipping an optional balanced argument list (`(Dispatchers.IO)`, `("/ws")`). Returns null
   * if what follows is not a trailing-lambda call (e.g. `launchIn(...)` — no `{`).
   */
  private fun trailingLambdaOpen(code: String, afterToken: Int): Int? {
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
          val rethrows = open >= 0 && endsWithUnconditionalThrow(body.substring(open + 1, end - 1))
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
      val guarded = hasCancellationGuard(body, catches, idx)
      if (!guarded) offsets.add(c.start)
    }
    return offsets
  }

  private fun hasCancellationGuard(body: String, catches: List<CatchClause>, idx: Int): Boolean {
    var guarded = false
    var j = idx - 1
    while (j >= 0 && body.substring(catches[j].blockEnd, catches[j + 1].start).isBlank()) {
      if (catches[j].simpleType == "CancellationException" && catches[j].rethrows) {
        guarded = true
        break
      }
      j--
    }
    return guarded
  }

  /**
   * True when the LAST top-level statement of [blockInner] (a catch block's contents, already
   * literal/comment-masked) is a `throw` and no earlier top-level statement can exit without
   * throwing — the tightened "re-surfaces cancellation" rule of issue #3192. A `throw` nested in a
   * conditional branch, `when` arm, or lambda, a throw followed by a non-throwing statement, and a
   * final throw bypassed by an earlier top-level `return`/`break`/`continue` all leave a path that
   * swallows, so none of them count. (A `return` nested inside a braced branch is blanked away and
   * not seen — the heuristic stays lexical.)
   */
  private fun endsWithUnconditionalThrow(blockInner: String): Boolean {
    val flat = blankNestedGroups(blockInner)
    val stmts = flat.split('\n', ';').map { it.trim() }.filter { it.isNotEmpty() }
    val last = stmts.lastOrNull() ?: return false
    if (!RETHROW_STATEMENT.containsMatchIn(last)) return false
    return stmts.dropLast(1).none { EARLY_EXIT.containsMatchIn(it) }
  }

  /**
   * Blank the contents of nested `{…}` and `(…)` groups — including their newlines — so top-level
   * statement splitting is not fooled by multi-line call arguments (`throw Wrap(\n "x",\n e,\n)`)
   * or lambda bodies (`handler.post { throw e }`). The outermost delimiters are kept so the result
   * still reads as one statement per top-level line.
   */
  private fun blankNestedGroups(s: String): String {
    val nesting = GroupNesting()
    return buildString(s.length) {
      for (c in s) append(nesting.mask(c))
    }
  }

  private class GroupNesting {
    private var brace = 0
    private var paren = 0

    fun mask(c: Char): Char =
      when {
        c == '{' -> {
          val visible = brace == 0 && paren == 0
          brace++
          if (visible) '{' else ' '
        }
        c == '}' -> {
          brace--
          if (brace == 0 && paren == 0) '}' else ' '
        }
        brace > 0 -> ' '
        else -> maskParentheses(c)
      }

    private fun maskParentheses(c: Char): Char =
      when (c) {
        '(' -> {
          val visible = paren == 0
          paren++
          if (visible) '(' else ' '
        }
        ')' -> {
          paren--
          if (paren == 0) ')' else ' '
        }
        else -> if (paren > 0) ' ' else c
      }
  }
}
