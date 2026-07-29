package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Structural regression guard for issue #4577.
 *
 * CtrlProxy is an AccessibilityService and cannot be constructed in a fast unit test. This source
 * test instead verifies that every stale-frame rejection routes through a closed action set, and
 * that the dispatch remains exhaustive without a silent fallback branch.
 */
class StaleFrameContextRejectionWiringTest {

  private val staleFrameActions =
    setOf("TAP", "SWIPE", "DRAG", "SET_TEXT", "IME_ACTION", "GLOBAL_ACTION")

  private val correlatedResponsePatternByAction =
    mapOf(
      "TAP" to
        Regex(
          """broadcastTapCoordinatesResult\(\s*requestId\s*,\s*false\s*,\s*error\s*,\s*0\s*\)"""
        ),
      "SWIPE" to
        Regex(
          """broadcastSwipeResult\(\s*requestId\s*,\s*false\s*,\s*error\s*,\s*0\s*,\s*null\s*\)"""
        ),
      "DRAG" to
        Regex(
          """broadcastDragResult\(\s*requestId\s*,\s*false\s*,\s*error\s*,\s*0\s*,\s*null\s*\)"""
        ),
      "SET_TEXT" to
        Regex("""broadcastSetTextResult\(\s*requestId\s*,\s*false\s*,\s*error\s*,\s*0\s*\)"""),
      "IME_ACTION" to
        Regex(
          """broadcastImeActionResult\(\s*requestId\s*,\s*action\.wireName\s*,\s*false\s*,\s*error\s*,\s*0\s*\)"""
        ),
      "GLOBAL_ACTION" to
        Regex(
          """(?s)GlobalActionResult\(\s*timestamp\s*=\s*System\.currentTimeMillis\(\)\s*,\s*requestId\s*=\s*requestId\s*,\s*success\s*=\s*false\s*,.*?\berror\s*=\s*error\s*,"""
        ),
    )

  @Test
  fun `stale frame rejection accepts a typed action and dispatches every action`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val signature = rejectionSignature(source)
    val body = rejectionBody(source)

    assertTrue(
      "rejectStaleFrameContext must accept StaleFrameContextAction rather than a raw String",
      "action: StaleFrameContextAction" in signature,
    )
    assertFalse(
      "the typed dispatch must stay exhaustive rather than silently ignoring a future action",
      Regex("""\belse\s*->""").containsMatchIn(body),
    )
    assertEquals(
      "every stale-frame action must retain an explicit correlated response envelope",
      staleFrameActions,
      routedActions(body),
    )
    correlatedResponsePatternByAction.forEach { (action, responsePattern) ->
      assertTrue(
        "$action must retain its established correlated stale-frame response",
        responsePattern.containsMatchIn(actionBranch(body, action)),
      )
    }
  }

  @Test
  fun `every frame context request selects a typed stale frame action`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())

    assertEquals(
      "a raw action string could enter the stale rejection dispatcher without a response",
      staleFrameActions,
      typedActionCallSites(source),
    )
  }

  private fun rejectionSignature(source: String): String {
    val start = source.indexOf("private fun rejectStaleFrameContext(")
    assertTrue("rejectStaleFrameContext not found in CtrlProxy.kt", start >= 0)
    val bodyOpen = source.indexOf('{', start)
    assertTrue("rejectStaleFrameContext body not found in CtrlProxy.kt", bodyOpen >= 0)
    return source.substring(start, bodyOpen)
  }

  private fun rejectionBody(source: String): String {
    val start = source.indexOf("private fun rejectStaleFrameContext(")
    assertTrue("rejectStaleFrameContext not found in CtrlProxy.kt", start >= 0)
    val bodyOpen = source.indexOf('{', start)
    assertTrue("rejectStaleFrameContext body not found in CtrlProxy.kt", bodyOpen >= 0)
    return source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
  }

  private fun routedActions(body: String): Set<String> =
    Regex("""StaleFrameContextAction\.([A-Z_]+)\s*->""")
      .findAll(body)
      .map { it.groupValues[1] }
      .toSet()

  private fun actionBranch(body: String, action: String): String {
    val marker = "StaleFrameContextAction.$action ->"
    val start = body.indexOf(marker)
    if (start < 0) return ""
    val next = body.indexOf("StaleFrameContextAction.", start + marker.length)
    return body.substring(start, if (next >= 0) next else body.length)
  }

  private fun typedActionCallSites(source: String): Set<String> =
    Regex(
        """rejectStaleFrameContext\(\s*requestId\s*,\s*frameContext\s*,\s*StaleFrameContextAction\.([A-Z_]+)\s*\)"""
      )
      .findAll(source)
      .map { it.groupValues[1] }
      .toSet()

  private fun readCtrlProxySource(): String = locateCtrlProxySource().readText()

  private fun locateCtrlProxySource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull { it.isFile }
    if (direct != null) return direct

    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
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
    fail("Could not locate CtrlProxy.kt from user.dir=${System.getProperty("user.dir")}")
    error("unreachable")
  }
}
