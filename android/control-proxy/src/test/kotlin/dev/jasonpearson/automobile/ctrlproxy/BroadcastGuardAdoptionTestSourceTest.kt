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
 * This test source-scans [CtrlProxy], [CaCertificateController] and [SettingsController] and fails
 * CI on either regression. The scanning logic is factored into [BroadcastGuardScanner] (a pure
 * function over source text) so the enforcement contract itself is unit-tested against synthetic
 * good/bad snippets — the real-file assertions then prove the live source complies.
 *
 * Scope: [ResultBroadcaster.guard] adoption is enforced fully (missing guard + reintroduced
 * swallow). [AsyncActionRunner] coverage is the swallow-regression check only. For raw
 * `serviceScope.launch { … }`, this scanner enforces the issue #3128 contract: a launch body that
 * captures `requestId` must attach [RequestIdContext] at the launch site, while legitimate
 * non-correlated launches (push events, subscriptions, logcat streaming) stay out of scope.
 * [ServiceScopeGuard]'s [kotlinx.coroutines.CoroutineExceptionHandler] remains the scope-level
 * backstop, and this class also enforces that its handler stays installed (the `serviceScope
 * installs the ServiceScopeGuard CoroutineExceptionHandler` test below).
 */
internal class BroadcastGuardAdoptionTestSourceTest {
  // ---------------------------------------------------------------------------
  // Real-source assertions — the live CtrlProxy.kt must comply.
  // ---------------------------------------------------------------------------

  @Test
  fun `every requestId-correlated broadcast helper in CtrlProxy routes through ResultBroadcaster guard`() {
    for ((fileName, source) in readGuardedSources()) {
      val result = BroadcastGuardScanner.scan(source)

      val missingGuard =
        result.violations.filter { it.kind == BroadcastGuardScanner.Kind.MISSING_GUARD }
      assertTrue(
        "Every `broadcast*Result/Error/Response(requestId: …)` helper must send through " +
          "`resultSender` or wrap its body in `resultBroadcaster.guard(...)` " +
          "(issues #3045, #3085, #11877). Offenders:\n" +
          missingGuard.joinToString("\n") { "  - ${it.symbol} ($fileName:${it.line})" },
        missingGuard.isEmpty(),
      )
    }
  }

  @Test
  fun `no requestId-correlated broadcast helper reintroduces an inner log-and-swallow`() {
    for ((fileName, source) in readGuardedSources()) {
      val result = BroadcastGuardScanner.scan(source)

      val swallows =
        result.violations.filter { it.kind == BroadcastGuardScanner.Kind.SWALLOW_IN_BROADCAST }
      assertTrue(
        "A guarded broadcast helper must not reintroduce an inner catch that logs-and-swallows — " +
          "the guard only fires on a throw that escapes the block (issue #3085). Offenders:\n" +
          swallows.joinToString("\n") { "  - ${it.symbol} ($fileName:${it.line})" },
        swallows.isEmpty(),
      )
    }
  }

  @Test
  fun `no asyncActionRunner launch block reintroduces an inner log-and-swallow`() {
    for ((fileName, source) in readGuardedSources()) {
      val result = BroadcastGuardScanner.scan(source)

      val swallows =
        result.violations.filter { it.kind == BroadcastGuardScanner.Kind.SWALLOW_IN_LAUNCH }
      assertTrue(
        "An `asyncActionRunner.launch { … }` block must not reintroduce an inner catch that " +
          "logs-and-swallows (issue #3023/#3085). Offenders:\n" +
          swallows.joinToString("\n") { "  - ${it.symbol} ($fileName:${it.line})" },
        swallows.isEmpty(),
      )
    }
  }

  @Test
  fun `no raw serviceScope launch captures requestId without RequestIdContext`() {
    for ((fileName, source) in readGuardedSources()) {
      val result = BroadcastGuardScanner.scan(source)

      val uncorrelatedLaunches =
        result.violations.filter { it.kind == BroadcastGuardScanner.Kind.RAW_REQUEST_ID_LAUNCH }
      assertTrue(
        "A raw `serviceScope.launch { ... }` block that captures `requestId` must attach " +
          "`RequestIdContext(requestId)` or route through `AsyncActionRunner`; otherwise " +
          "ServiceScopeGuard can only emit a null-id error frame (issue #3128). Offenders:\n" +
          uncorrelatedLaunches.joinToString("\n") { "  - ${it.symbol} ($fileName:${it.line})" },
        uncorrelatedLaunches.isEmpty(),
      )
    }
  }

  @Test
  fun `launchRequestScope attaches RequestIdContext requestId`() {
    val source = readCtrlProxySource()
    val helper = Regex("""fun\s+launchRequestScope\(""").find(source)
    if (helper == null) {
      fail("could not find the `launchRequestScope(...)` helper in CtrlProxy.kt")
    }

    val signatureEnd = KotlinSourceScan.matchParen(source, helper!!.range.last)
    val bodyOrExpressionEnd =
      source.indexOf("\n\n", signatureEnd).takeIf { it >= 0 } ?: source.length
    val helperText = source.substring(helper.range.first, bodyOrExpressionEnd)
    assertTrue(
      "`launchRequestScope` must attach `RequestIdContext(requestId)` so all helper-routed raw " +
        "launches stay correlated (issue #3128). Helper text was: $helperText",
      Regex("""serviceScope\.launch\s*\([^)]*RequestIdContext\s*\(\s*requestId\s*\)""")
        .containsMatchIn(helperText),
    )
  }

  @Test
  fun `serviceScope installs the ServiceScopeGuard CoroutineExceptionHandler`() {
    // Enforcement backstop for issue #3104/#3128: request-correlated raw launches only fail fast
    // if the guard's handler is actually part of the scope's context. If the `serviceScope =
    // CoroutineScope(...)` initializer ever drops `serviceScopeGuard.handler`, a throw in a
    // context-tagged launch would again escape to the bare SupervisorJob with no error frame — so
    // fail CI the moment the wiring regresses.
    val source = readCtrlProxySource()

    // Match the `val serviceScope[: Type] = CoroutineScope(` declaration, then take the initializer
    // text up to the end of that statement's line-continuation. Nested parens (`SupervisorJob()`)
    // make a `[^)]*` capture unreliable, so scan a bounded window after the declaration instead.
    val decl = Regex("""val\s+serviceScope\s*(?::[^=]+)?=\s*CoroutineScope\(""").find(source)
    if (decl == null) {
      fail("could not find the `serviceScope = CoroutineScope(...)` initializer in CtrlProxy.kt")
    }

    val window = source.substring(decl!!.range.last, minOf(source.length, decl.range.last + 200))
    assertTrue(
      "serviceScope must be built with `serviceScopeGuard.handler` so uncaught throws in raw " +
        "launches emit a correlated error frame (issue #3104). Initializer window was: $window",
      window.contains("serviceScopeGuard.handler"),
    )
  }

  @Test
  fun `scanner actually matches the CtrlProxy broadcast helper set`() {
    // Guards against a scanner that silently matches nothing (a broken regex would make every
    // "no violations" assertion vacuously pass). CtrlProxy has 31 such helpers today; assert a
    // conservative lower bound plus a few known members so the check stays meaningful as helpers
    // are added or removed.
    val result = BroadcastGuardScanner.scan(readGuardedSources().joinToString("\n") { it.second })

    assertTrue(
      "expected the scanner to match the CtrlProxy broadcast helpers, found " +
        "${result.guardedHelpers.size}: ${result.guardedHelpers}",
      result.guardedHelpers.size >= 25,
    )
    for (known in
      listOf(
        "broadcastCaCertResult",
        "broadcastSettingsGetResult",
        "broadcastPreferencesResult",
        "broadcastInstalledPackagesResult",
        "broadcastDeviceOwnerStatusResult",
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
    assertTrue(
      "expected the scanner to find raw serviceScope.launch blocks, found " +
        result.rawLaunchBlocks,
      result.rawLaunchBlocks >= 10,
    )
  }

  // ---------------------------------------------------------------------------
  // Contract tests — prove the scanner catches each regression and does not
  // false-positive on legitimate code. These define the enforcement contract.
  // ---------------------------------------------------------------------------

  @Test
  fun `bypassing the result sender is detected on both controller result helpers`() {
    // ResultSender guards every send, so the regression is a helper that writes to the server
    // directly instead.
    val source =
      locateSource("CaCertificateController.kt")
        .readText()
        .replace(
          "resultSender.sendFrame(outcome.requestId, \"ca_cert_result\")",
          "webSocketServer.broadcastWithPerf",
        )
        .replace(
          "resultSender.sendFrame(requestId, \"device_owner_status_result\")",
          "webSocketServer.broadcastWithPerf",
        )

    val missing =
      BroadcastGuardScanner.scan(source).violations.filter {
        it.kind == BroadcastGuardScanner.Kind.MISSING_GUARD
      }

    assertEquals(
      setOf("broadcastCaCertResult", "broadcastDeviceOwnerStatusResult"),
      missing.map { it.symbol }.toSet(),
    )
  }

  // ---------------------------------------------------------------------------
  // Source location
  // ---------------------------------------------------------------------------

  private fun readGuardedSources(): List<Pair<String, String>> =
    listOf(
        "CtrlProxy.kt",
        "CaCertificateController.kt",
        "SettingsController.kt",
        "PackageController.kt",
        "StorageController.kt",
        "ClipboardController.kt",
        "FocusController.kt",
        "TextInputController.kt",
        "ImeController.kt",
        "SdkControlController.kt",
        "GestureController.kt",
        "FailureReceivers.kt",
        "PackageScreenReceivers.kt",
        "CommandReceivers.kt",
        "ScreenshotRequestHandler.kt",
        "FrameContextGate.kt",
      )
      .map { fileName ->
        fileName to locateSource(fileName).readText()
      }

  private fun readCtrlProxySource(): String = locateSource("CtrlProxy.kt").readText()

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
 * Pure, Android-free source scanner for the [BroadcastGuardAdoptionTestSourceTest] enforcement.
 * Reads Kotlin source as text and reports guard-adoption violations. Test-only (lives in the test
 * source set) — ships no scanning code in the app.
 */
internal object BroadcastGuardScanner {

  enum class Kind {
    /**
     * A requestId-correlated broadcast helper whose body never calls `resultBroadcaster.guard(`.
     */
    MISSING_GUARD,
    /** A requestId-correlated broadcast helper with an inner catch that logs-and-swallows. */
    SWALLOW_IN_BROADCAST,
    /** An `asyncActionRunner.launch { … }` block with an inner catch that logs-and-swallows. */
    SWALLOW_IN_LAUNCH,
    /** A raw `serviceScope.launch { … }` block captures requestId without RequestIdContext. */
    RAW_REQUEST_ID_LAUNCH,
  }

  data class Violation(val kind: Kind, val symbol: String, val line: Int)

  data class ScanResult(
    /**
     * Names of requestId-correlated `broadcast*Result/Error/Response` helpers that were matched.
     */
    val guardedHelpers: List<String>,
    /** Count of `asyncActionRunner.launch(...)` blocks that were matched. */
    val launchBlocks: Int,
    /** Count of raw `serviceScope.launch` blocks that were matched. */
    val rawLaunchBlocks: Int,
    val violations: List<Violation>,
  )

  // `suspend` is optional so a non-suspend `private fun broadcast*Result(requestId)` (the shape of
  // the existing `broadcastScreenshot`) can't evade the scan by dropping `suspend`. The naming
  // suffix (Result/Error/Response) + a `requestId` param or correlated `outcome` parameter object
  // is the load-bearing discriminator that
  // separates requestId-correlated result broadcasters (must be guarded) from push-event
  // broadcasters (`*Event`/`*Update`/`*Change`, no requestId) that legitimately log-and-swallow.
  private val HELPER = Regex("""(?:suspend )?fun (broadcast\w*(?:Result|Error|Response))\(""")
  private val LAUNCH = Regex("""asyncActionRunner\.launch\(""")
  private val SERVICE_SCOPE_LAUNCH = Regex("""serviceScope\.launch""")
  private val REQUEST_ID_CONTEXT =
    Regex("""RequestIdContext\s*\(\s*(?:requestId|requestId\s*=\s*requestId)\s*\)""")
  private val REQUEST_ID_TOKEN = Regex("""\brequestId\b""")
  private val REQUEST_ID_ALIAS = Regex("""\b(?:val|var)\s+([A-Za-z_]\w*)\s*=\s*requestId\b""")
  private val GUARD_CALL = Regex("""resultBroadcaster\.guard\(""")
  private val CATCH = Regex("""catch\s*\(""")
  // The actual result emission. Every such call in a helper must sit *inside* a guard (or launch)
  // block — proving the guard is merely *mentioned* is not enough (a token guard call with the real
  // broadcast outside it would still hang; issue #3085 regression form).
  private val BROADCAST_CALL = Regex("""(?:webSocketServer|responseSender)\.broadcast""")
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
    val code = KotlinSourceScan.maskLiteralsAndComments(source)

    val guardedHelpers = mutableListOf<String>()
    val violations = mutableListOf<Violation>()

    for (m in HELPER.findAll(code)) {
      val name = m.groupValues[1]
      val sigEnd =
        KotlinSourceScan.matchParen(code, m.range.first + m.value.indexOf('(')) // index after ')'
      val signature = code.substring(m.range.first, sigEnd)
      if (!signature.contains("requestId") && !signature.contains("outcome:"))
        continue // only requestId-correlated helpers are in scope

      guardedHelpers.add(name)

      val bodyOpen = code.indexOf('{', sigEnd)
      val bodyClose = KotlinSourceScan.matchBrace(code, bodyOpen)
      val body = code.substring(bodyOpen, bodyClose)

      violations.addAll(unguardedBroadcasts(source, body, bodyOpen, name))
      for (offset in swallowingCatchOffsets(body)) {
        violations.add(
          Violation(
            Kind.SWALLOW_IN_BROADCAST,
            name,
            KotlinSourceScan.lineOf(source, bodyOpen + offset),
          ),
        )
      }
    }

    val launchBlocks = scanGuardedLaunches(source, code, violations)
    val rawLaunchBlocks = scanRawLaunches(source, code, violations)
    return ScanResult(guardedHelpers, launchBlocks, rawLaunchBlocks, violations)
  }

  private fun scanGuardedLaunches(
    source: String,
    code: String,
    violations: MutableList<Violation>,
  ): Int {
    var launchBlocks = 0
    for (m in LAUNCH.findAll(code)) {
      launchBlocks++
      val parenEnd = KotlinSourceScan.matchParen(code, m.range.first + m.value.indexOf('('))
      val blockOpen = code.indexOf('{', parenEnd)
      val blockClose = KotlinSourceScan.matchBrace(code, blockOpen)
      val block = code.substring(blockOpen, blockClose)
      for (offset in swallowingCatchOffsets(block)) {
        violations.add(
          Violation(
            Kind.SWALLOW_IN_LAUNCH,
            "asyncActionRunner.launch",
            KotlinSourceScan.lineOf(source, blockOpen + offset),
          ),
        )
      }
    }

    return launchBlocks
  }

  private fun scanRawLaunches(
    source: String,
    code: String,
    violations: MutableList<Violation>,
  ): Int {
    var rawLaunchBlocks = 0
    for (m in SERVICE_SCOPE_LAUNCH.findAll(code)) {
      val call = parseLaunchCall(code, m.range.last + 1) ?: continue
      rawLaunchBlocks++
      val block = code.substring(call.blockOpen, call.blockClose)
      val enclosingPrefix = code.substring(0, m.range.first)
      val requestIdTokens = requestIdTokens(enclosingPrefix)
      if (
        requestIdTokens.any { token ->
          Regex("""\b${Regex.escape(token)}\b""").containsMatchIn(block)
        } && !REQUEST_ID_CONTEXT.containsMatchIn(call.args)
      ) {
        violations.add(
          Violation(
            Kind.RAW_REQUEST_ID_LAUNCH,
            "serviceScope.launch",
            KotlinSourceScan.lineOf(source, call.blockOpen),
          ),
        )
      }
    }

    return rawLaunchBlocks
  }

  private fun unguardedBroadcasts(
    source: String,
    body: String,
    bodyOpen: Int,
    name: String,
  ): List<Violation> {
    val violations = mutableListOf<Violation>()
    // The correlated-error-on-throw guarantee is provided by `resultBroadcaster.guard { … }` (the
    // direct path) or by delegating the broadcast into `asyncActionRunner.launch { … }` (which is
    // itself swallow-checked below). Collect the spans of both.
    val guardedSpans = blockSpans(body, GUARD_CALL) + blockSpans(body, LAUNCH)
    val broadcastCalls = BROADCAST_CALL.findAll(body).map { it.range.first }.toList()
    when {
      guardedSpans.isEmpty() && broadcastCalls.isNotEmpty() ->
        // Broadcasts a result but wraps none of it — the exact "forgot the guard" regression.
        violations.add(
          Violation(
            Kind.MISSING_GUARD,
            name,
            KotlinSourceScan.lineOf(source, bodyOpen + broadcastCalls.first()),
          ),
        )
      else ->
        // Guard/launch present: every result broadcast must sit *inside* one of those spans. A
        // broadcast outside them is unguarded even though the guard call textually exists.
        for (offset in broadcastCalls) {
          if (guardedSpans.none { offset >= it.first && offset < it.second }) {
            violations.add(
              Violation(
                Kind.MISSING_GUARD,
                name,
                KotlinSourceScan.lineOf(source, bodyOpen + offset),
              ),
            )
          }
        }
    }
    return violations
  }

  private fun requestIdTokens(enclosingPrefix: String): Set<String> = buildSet {
    add("requestId")
    REQUEST_ID_ALIAS.findAll(enclosingPrefix).forEach { add(it.groupValues[1]) }
  }

  private data class LaunchCall(val args: String, val blockOpen: Int, val blockClose: Int)

  private fun parseLaunchCall(code: String, afterName: Int): LaunchCall? {
    var cursor = afterName
    while (cursor < code.length && code[cursor].isWhitespace()) cursor++

    val args: String
    if (cursor < code.length && code[cursor] == '(') {
      val argsStart = cursor + 1
      val parenEnd = KotlinSourceScan.matchParen(code, cursor)
      args = code.substring(argsStart, parenEnd - 1)
      findInlineBlockArgument(code, argsStart, parenEnd - 1)?.let { blockOpen ->
        return LaunchCall(args, blockOpen, KotlinSourceScan.matchBrace(code, blockOpen))
      }
      cursor = parenEnd
    } else {
      args = ""
    }

    while (cursor < code.length && code[cursor].isWhitespace()) cursor++
    if (cursor >= code.length || code[cursor] != '{') return null

    val blockOpen = code.indexOf('{', cursor)
    return LaunchCall(args, blockOpen, KotlinSourceScan.matchBrace(code, blockOpen))
  }

  private fun findInlineBlockArgument(code: String, start: Int, endExclusive: Int): Int? {
    val blockArg = Regex("""\bblock\s*=""")
    for (m in blockArg.findAll(code.substring(start, endExclusive))) {
      var cursor = start + m.range.last + 1
      while (cursor < endExclusive && code[cursor].isWhitespace()) cursor++
      if (cursor < endExclusive && code[cursor] == '{') return cursor
    }
    return null
  }

  /**
   * Spans (`[open, close)` of the block `{ … }`) of each call matching [call] found in [region].
   */
  private fun blockSpans(region: String, call: Regex): List<Pair<Int, Int>> {
    val spans = mutableListOf<Pair<Int, Int>>()
    for (m in call.findAll(region)) {
      val parenEnd = KotlinSourceScan.matchParen(region, m.range.first + m.value.indexOf('('))
      val blockOpen = region.indexOf('{', parenEnd)
      if (blockOpen < 0) continue
      spans.add(blockOpen to KotlinSourceScan.matchBrace(region, blockOpen))
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
      val parenEnd = KotlinSourceScan.matchParen(region, c.range.first + c.value.indexOf('('))
      val blockOpen = region.indexOf('{', parenEnd)
      if (blockOpen < 0) continue
      val blockClose = KotlinSourceScan.matchBrace(region, blockOpen)
      val catchBody = region.substring(blockOpen, blockClose)
      val surfacesViaBroadcast =
        BROADCAST_CALL_TOKEN.findAll(catchBody).any { !EVENT_BROADCAST_TOKEN.matches(it.value) }
      val surfaces = RETHROW.containsMatchIn(catchBody) || surfacesViaBroadcast
      if (!surfaces) offsets.add(c.range.first)
    }
    return offsets
  }
}
