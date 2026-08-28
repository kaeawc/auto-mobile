package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Regression guard for #5685.
 *
 * A successful ACTION_SET_TEXT changes the device immediately. Its correlated result must be
 * broadcast before optional hierarchy settling and extraction, whose latency otherwise turns a
 * completed write into a host-side timeout.
 *
 * CtrlProxy is an AccessibilityService and cannot be constructed in a fast unit test. This
 * Android-free source test verifies the ordering at the production call site.
 */
class SetTextAcknowledgementOrderTest {

  @Test
  fun `performSetText acknowledges a successful action before hierarchy postprocessing`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performSetText(")
    val action = body.indexOf("targetNode.performAction(")
    val acknowledgement = body.indexOf("broadcastSetTextResult(", startIndex = action)
    val hierarchy = body.indexOf("hierarchyDebouncer.extractAfterQuiescence(", startIndex = action)

    assertTrue("performSetText must call ACTION_SET_TEXT", action >= 0)
    assertTrue(
      "performSetText must broadcast set_text_result after ACTION_SET_TEXT",
      acknowledgement > action,
    )
    assertTrue(
      "performSetText must post-process the hierarchy after ACTION_SET_TEXT",
      hierarchy > action,
    )
    assertTrue(
      "set_text_result must acknowledge a successful ACTION_SET_TEXT before hierarchy postprocessing",
      acknowledgement < hierarchy,
    )

    val broadcaster = functionBody(source, "private suspend fun broadcastSetTextResult(")
    assertTrue(
      "set_text_result must use synchronous delivery instead of the backpressured event flow",
      "webSocketServer.broadcastWithPerfSync" in broadcaster,
    )
  }

  private fun functionBody(source: String, signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) fail("$signature not found in CtrlProxy.kt")
    val open = source.indexOf('{', start)
    if (open < 0) fail("$signature body not found in CtrlProxy.kt")
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }

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
