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
    val body = functionBody(source, "private suspend fun performSetText(")
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
      "hierarchyDebouncer.extractAfterQuiescenceSuspending(" in refreshBody,
    )

    val broadcaster = functionBody(source, "private suspend fun broadcastSetTextResult(")
    assertTrue(
      "set_text_result must use synchronous delivery instead of the backpressured event flow",
      "webSocketServer.broadcastWithPerfSync" in broadcaster,
    )
  }

  @Test
  fun `performInsertText validates password and actions before mutating text`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val passwordGuard = body.indexOf("if (targetNode.isPassword)")
    val selectionPlan = body.indexOf("planInsertText(")
    val refresh = body.indexOf("var snapshot = readFreshSnapshot()")
    val unsupportedAction = body.indexOf("val unsupportedAction")
    val setText = body.indexOf("targetNode.performAction(", startIndex = unsupportedAction)

    assertTrue("performInsertText must reject password fields", passwordGuard >= 0)
    assertTrue(
      "performInsertText must reject password fields before reading masked text",
      selectionPlan > passwordGuard,
    )
    assertTrue(
      "performInsertText must refresh every node before planning",
      refresh >= 0 && selectionPlan > refresh,
    )
    assertTrue(
      "performInsertText must validate the required accessibility actions",
      unsupportedAction > selectionPlan,
    )
    assertTrue(
      "performInsertText must validate selection and actions before ACTION_SET_TEXT",
      setText > unsupportedAction,
    )
  }

  @Test
  fun `refresh replacements are validated before reading text and remembered state has hooks`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val refresh = functionBody(body, "fun readFreshSnapshot()")
    val guard =
      refresh.indexOf(
        "if (!targetNode.isEditable || !targetNode.isFocused || targetNode.isPassword)",
      )
    assertTrue(guard >= 0 && refresh.indexOf("targetNode.text?.toString()") > guard)
    assertTrue(
      body.contains("it == remembered &&") &&
        body.contains("android.os.SystemClock.uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS"),
    )
    for (signature in
      listOf(
        "private suspend fun performSetText(",
        "private fun performImeAction(",
        "private fun performSelectAll(",
        "private fun performNodeAction(",
        "private fun performGlobalActionRequest(",
        "override fun requestGestureStart(",
        "override fun requestGestureMove(",
        "override fun requestGestureEnd(",
      )) {
      assertTrue(
        "$signature clears caret",
        functionBody(source, signature).contains("rememberedInsert = null"),
      )
    }
    val gestureStart = source.indexOf("private fun dispatchGestureWithResult(")
    val gestureLifecycle = source.indexOf("val lifecycle", gestureStart)
    assertTrue(source.substring(gestureStart, gestureLifecycle).contains("rememberedInsert = null"))
    val events = functionBody(source, "override fun onAccessibilityEvent(")
    assertTrue(events.indexOf("rememberedInsert = null") < events.indexOf("val connectionCount"))
    assertTrue(events.contains("AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED"))
  }

  @Test
  fun `performInsertText waits for mutation before reading selection actions`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val mutation = body.indexOf("textMutated = setTextSucceeded")
    val poll = body.indexOf("awaitInsertTextMutation(", startIndex = mutation)
    val selection = body.indexOf("val selectionAttempted", startIndex = mutation)
    val actionList = body.indexOf("targetNode.actionList", startIndex = selection)
    assertTrue(
      "successful SET_TEXT must poll before deciding selection",
      poll > mutation && poll < selection,
    )
    assertTrue("selection support must be re-read after polling", actionList > selection)
    assertTrue(
      "poll must refresh the original mutation node",
      body.contains("readSnapshot = ::readMutationSnapshot"),
    )
    assertTrue(
      "poll must only run after successful SET_TEXT",
      body.contains("if (setTextSucceeded)"),
    )
    val refresh = functionBody(body, "fun readMutationSnapshot()")
    assertTrue(refresh.contains("!targetNode.refresh()"))
    assertTrue(refresh.contains("nodeKey() != mutationNodeKey"))
    assertTrue(refresh.contains("targetNode.isPassword"))
    assertTrue(
      "mutation refresh must not re-find another field",
      !refresh.contains("findFocusedEditableNode"),
    )
  }

  @Test
  fun `performInsertText reports caret warnings after attempting selection`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val selection = body.indexOf("val selectionReturned")
    val selectionAction = body.indexOf("targetNode.performAction(", startIndex = selection)
    val selectionDecision = body.indexOf("val selectionSucceeded", startIndex = selectionAction)
    val outcome = body.indexOf("insertTextOutcome(")
    val broadcast = body.indexOf("broadcastInsertTextResult(", startIndex = outcome)
    assertTrue(
      "outcome must follow the selection attempt",
      selection >= 0 &&
        selectionAction > selection &&
        selectionDecision > selectionAction &&
        outcome > selectionDecision,
    )
    assertTrue("acknowledgement must include the computed outcome", broadcast > outcome)
    val broadcaster = functionBody(source, "private suspend fun broadcastInsertTextResult(")
    val rawBroadcaster =
      functionBody(readCtrlProxySource(), "private suspend fun broadcastInsertTextResult(")
    assertTrue(
      "legacy partialApplication must be serialized",
      "put(\"partialApplication\", true)" in rawBroadcaster,
    )
    assertTrue("success must be serialized", "put(\"success\", success)" in rawBroadcaster)
    assertTrue("partialApplication must be guarded", "if (partialApplication)" in broadcaster)
    assertTrue(
      "insert acknowledgements must be synchronous",
      "webSocketServer.broadcastWithPerfSync" in broadcaster,
    )
    assertTrue("error must be serialized", "put(\"error\", error)" in rawBroadcaster)
    for (field in listOf("warning", "caretPlaced", "resultingTextLength")) {
      val guard = broadcaster.indexOf("if ($field != null)")
      assertTrue("optional $field must be guarded", guard >= 0)
      assertTrue(
        "optional $field must serialize its value",
        "put(\"$field\", $field)" in rawBroadcaster,
      )
      assertTrue(
        "optional $field must be serialized after its guard",
        broadcaster.indexOf("put(", startIndex = guard) > guard,
      )
    }
  }

  @Test
  fun `performInsertText acknowledges before asynchronously refreshing successful text mutations`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    val body = functionBody(source, "private fun performInsertText(")
    val setText = body.indexOf("targetNode.performAction(")
    val acknowledgement = body.indexOf("broadcastInsertTextResult(", startIndex = setText)
    val refresh = body.indexOf("refreshHierarchyAfterTextInput()", startIndex = acknowledgement)
    val successfulMutationRefresh =
      body.indexOf("if (setTextSucceeded) refreshHierarchyAfterTextInput()")

    assertTrue("performInsertText must call ACTION_SET_TEXT", setText >= 0)
    assertTrue(
      "insert_text_result must acknowledge the text mutation before hierarchy postprocessing",
      acknowledgement > setText && refresh > acknowledgement,
    )
    assertTrue(
      "insert text must refresh changed text when caret restoration is only partially applied",
      successfulMutationRefresh > acknowledgement,
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
