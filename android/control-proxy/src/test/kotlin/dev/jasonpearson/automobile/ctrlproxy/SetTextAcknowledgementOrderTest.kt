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
    val refresh = body.indexOf("refreshHierarchyAfterTextInput()", startIndex = action)

    assertTrue("performSetText must call ACTION_SET_TEXT", action >= 0)
    assertTrue(
      "performSetText must broadcast set_text_result after ACTION_SET_TEXT",
      acknowledgement > action,
    )
    assertTrue(
      "performSetText must post-process the hierarchy after ACTION_SET_TEXT",
      refresh > action,
    )
    assertTrue(
      "set_text_result must acknowledge a successful ACTION_SET_TEXT before hierarchy postprocessing",
      acknowledgement < refresh,
    )
    val refreshBody = functionBody(source, "private fun refreshHierarchyAfterTextInput()")
    assertTrue(
      "text hierarchy refresh must wait for quiescence",
      "hierarchyDebouncer.extractAfterQuiescence(" in refreshBody,
    )

    val broadcaster = functionBody(source, "private suspend fun broadcastSetTextResult(")
    assertTrue(
      "set_text_result must use synchronous delivery instead of the backpressured event flow",
      "webSocketServer.broadcastWithPerfSync" in broadcaster,
    )
  }

  @Test
  fun `performInsertText validates password caret and actions before mutating text`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val passwordGuard = body.indexOf("if (targetNode.isPassword)")
    val currentText = body.indexOf("val currentText")
    val invalidSelection = body.indexOf("if (!hasValidSelection)")
    val unsupportedAction = body.indexOf("val unsupportedAction")
    val setText = body.indexOf("targetNode.performAction(", startIndex = unsupportedAction)

    assertTrue("performInsertText must reject password fields", passwordGuard >= 0)
    assertTrue(
      "performInsertText must reject password fields before reading masked text",
      currentText > passwordGuard,
    )
    assertTrue("performInsertText must reject an unknown selection", invalidSelection > currentText)
    assertTrue(
      "performInsertText must validate the required accessibility actions",
      unsupportedAction > invalidSelection,
    )
    assertTrue(
      "performInsertText must validate selection and actions before ACTION_SET_TEXT",
      setText > unsupportedAction,
    )
  }

  @Test
  fun `performInsertText identifies a partial application after caret restore failure`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val partial = body.indexOf("val partialApplication = setTextSucceeded && !selectionSucceeded")
    val broadcast = body.indexOf("broadcastInsertTextResult(", startIndex = partial)
    val broadcaster = functionBody(source, "private suspend fun broadcastInsertTextResult(")
    val partialGuard = broadcaster.indexOf("if (partialApplication)")
    val partialField = broadcaster.indexOf("put(", startIndex = partialGuard)

    assertTrue("performInsertText must identify an applied text mutation", partial >= 0)
    assertTrue(
      "performInsertText must include partial-application state in its result",
      broadcast > partial,
    )
    assertTrue(
      "insert_text_result must serialize partial-application state",
      partialGuard >= 0 && partialField > partialGuard,
    )
  }

  @Test
  fun `performInsertText acknowledges before asynchronously refreshing successful text mutations`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val setText = body.indexOf("targetNode.performAction(")
    val acknowledgement = body.indexOf("broadcastInsertTextResult(", startIndex = setText)
    val refresh = body.indexOf("refreshHierarchyAfterTextInput()", startIndex = acknowledgement)

    assertTrue("performInsertText must call ACTION_SET_TEXT", setText >= 0)
    assertTrue(
      "insert_text_result must acknowledge the text mutation before hierarchy postprocessing",
      acknowledgement > setText && refresh > acknowledgement,
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
