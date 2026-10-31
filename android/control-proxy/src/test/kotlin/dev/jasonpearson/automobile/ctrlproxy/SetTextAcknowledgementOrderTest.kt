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
 * The behaviour itself is pinned by [TextInputControllerTest]; this Android-free source test keeps
 * the statement ordering at the production call sites in [TextInputController] (and the caret
 * invalidation hooks that stay in CtrlProxy) from drifting.
 */
class SetTextAcknowledgementOrderTest {

  @Test
  fun `performSetText acknowledges a successful action before hierarchy postprocessing`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val entry = functionBody(source, "suspend fun performSetText(")
    assertTrue(
      entry.contains("SetTextOperation(requestId, text, resourceId, dismissKeyboard).run()"),
    )
    val operation = functionBody(source, "private inner class SetTextOperation(")
    assertTrue(functionBody(operation, "suspend fun run()").contains("perform()"))
    val body = functionBody(operation, "private suspend fun perform()")
    val mutation = functionBody(source, "private fun applySetText(")
    assertTrue(mutation.contains("targetNode.performAction("))
    val action = body.indexOf("applySetText(targetNode, text)")
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
      "text hierarchy refresh must publish the settled hierarchy",
      "host.publishSettledHierarchy()" in refreshBody,
    )
    val serviceSource = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    assertTrue(
      "the service's settled-hierarchy hook must wait for quiescence",
      "hierarchyController.debouncer.extractAfterQuiescenceSuspending(" in
        functionBody(serviceSource, "override suspend fun publishSettledHierarchy()"),
    )

    val broadcaster = functionBody(source, "suspend fun broadcastSetTextResult(")
    assertTrue(
      "set_text_result must go through the shared result sender",
      "resultSender.sendFrame" in broadcaster,
    )
    assertResultSenderEnqueuesDirectly(serviceSource)
  }

  @Test
  fun `performInsertText validates password and actions before mutating text`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val entry = functionBody(source, "suspend fun performInsertText(")
    assertTrue(
      "performInsertText must run its request operation",
      "InsertOperation(" in entry && ".run()" in entry,
    )
    val operation = functionBody(source, "private inner class InsertOperation(")
    val run = functionBody(operation, "suspend fun run()")
    val initialize = run.indexOf("if (!initializeNode()) return")
    val prepare = run.indexOf("prepareInsert()")
    val apply = run.indexOf("applyInsert(")
    assertTrue(
      "password validation must precede preparation and mutation",
      initialize >= 0 && prepare > initialize && apply > prepare,
    )

    val initialization = functionBody(operation, "private suspend fun initializeNode()")
    val passwordGuard = initialization.indexOf("if (targetNode.isPassword)")
    assertTrue("performInsertText must reject password fields", passwordGuard >= 0)
    assertTrue(
      "password fields must return before preparation",
      initialization.indexOf("return false", passwordGuard) > passwordGuard,
    )
    val preparation = functionBody(operation, "private inner class InsertPreparation")
    val refresh = preparation.indexOf("private var snapshot = readFreshSnapshot()")
    val selectionPlan = preparation.indexOf("planInsertText(")
    assertTrue(
      "performInsertText must refresh every node before planning",
      refresh >= 0 && selectionPlan > refresh,
    )

    val application = functionBody(operation, "private inner class InsertApplication(")
    val applicationBody = functionBody(application, "suspend fun apply()")
    val validation = applicationBody.indexOf("if (!supportsActions()) return")
    assertTrue(
      "required actions must be checked before mutation",
      validation >= 0 && applicationBody.indexOf("mutate()") > validation,
    )
    val validationBody = functionBody(application, "private suspend fun supportsActions()")
    assertTrue(
      "performInsertText must validate required accessibility actions",
      "val unsupportedAction" in validationBody,
    )
    val mutation = functionBody(application, "private suspend fun mutate()")
    assertTrue(
      "validated mutation must call ACTION_SET_TEXT",
      "targetNode.performAction(" in mutation && "ACTION_SET_TEXT," in mutation,
    )
  }

  @Test
  fun `refresh replacements are validated before reading text and remembered state has hooks`() {
    assertFreshSnapshotValidation()
    assertCaretResetHooks()
  }

  private fun assertFreshSnapshotValidation() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val body = functionBody(source, "private inner class InsertOperation(")
    val refresh = functionBody(body, "fun readFreshSnapshot()")
    val guard =
      refresh.indexOf(
        "if (!targetNode.isEditable || !targetNode.isFocused || targetNode.isPassword)",
      )
    assertTrue(guard >= 0 && refresh.indexOf("targetNode.text?.toString()") > guard)
    assertTrue(
      body.contains("it == remembered &&") &&
        body.contains("uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS"),
    )
    for (signature in
      listOf(
        "suspend fun performSetText(",
        "suspend fun performImeAction(",
        "suspend fun performSelectAll(",
      )) {
      assertTrue(
        "$signature clears caret",
        functionBody(source, signature).contains("rememberedInsert = null"),
      )
    }
  }

  private fun assertCaretResetHooks() {
    val forget = "textInputController.forgetRememberedInsert()"
    val serviceSource = KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource())
    for (signature in
      listOf(
        "override suspend fun requestClickFocusedInput(",
      )) {
      assertTrue("$signature clears caret", functionBody(serviceSource, signature).contains(forget))
    }
    // Global actions moved to GlobalActionController (#11876); its Host seam reaches the caret.
    val globalActionSource =
      KotlinSourceScan.maskLiteralsAndComments(locateSource("GlobalActionController.kt").readText())
    assertTrue(
      "performGlobalActionRequest clears caret",
      functionBody(globalActionSource, "fun performGlobalActionRequest(")
        .contains("host.forgetRememberedInsert()"),
    )
    // The commit path moved to ImeController (#11876); its Host seam is wired to the same caret.
    val imeSource =
      KotlinSourceScan.maskLiteralsAndComments(locateSource("ImeController.kt").readText())
    assertTrue(
      "requestCommitText clears caret",
      functionBody(imeSource, "suspend fun requestCommitText(")
        .contains("host.forgetRememberedInsert()"),
    )
    val nodeActionSource =
      KotlinSourceScan.maskLiteralsAndComments(locateSource("NodeActionController.kt").readText())
    assertTrue(
      "performNodeAction clears caret",
      functionBody(nodeActionSource, "suspend fun performNodeAction(")
        .contains("host.forgetRememberedInsert()"),
    )
    // Gestures reach the caret through GestureController.Host, which the service wires to it.
    assertTrue(serviceSource.contains("override fun forgetRememberedInsert() = $forget"))
    val gestureSource = KotlinSourceScan.maskLiteralsAndComments(readGestureSource())
    val hostForget = "host.forgetRememberedInsert()"
    for (signature in listOf("fun startStream(", "fun moveStream(", "fun endStream(")) {
      assertTrue(
        "$signature clears caret",
        functionBody(gestureSource, signature).contains(hostForget),
      )
    }
    val gestureStart = gestureSource.indexOf("private fun dispatchGestureWithResult(")
    val gestureLifecycle = gestureSource.indexOf("val lifecycle", gestureStart)
    assertTrue(gestureSource.substring(gestureStart, gestureLifecycle).contains(hostForget))
    val events = functionBody(serviceSource, "override fun onAccessibilityEvent(")
    assertTrue(events.indexOf(forget) in 0 until events.indexOf("val connectionCount"))
    assertTrue(events.contains("AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED"))
    assertTrue(
      events.contains("textInputController.onTextSelectionChanged(event.fromIndex, event.toIndex)"),
    )
  }

  @Test
  fun `performInsertText waits for mutation before reading selection actions`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val body = functionBody(source, "private suspend fun mutate()")
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
      body.contains("readSnapshot = { readMutationSnapshot(mutationNodeKey) }"),
    )
    assertTrue(
      "poll must only run after successful SET_TEXT",
      body.contains("if (setTextSucceeded)"),
    )
    val refresh = functionBody(source, "private fun readMutationSnapshot(")
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
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val body = functionBody(source, "suspend fun apply()")
    val mutation = functionBody(source, "private suspend fun mutate()")
    val selection = mutation.indexOf("val selectionReturned")
    val selectionAction =
      mutation.indexOf("placeInsertCaret(targetNode, plan.caret)", startIndex = selection)
    val caret = functionBody(source, "private fun placeInsertCaret(")
    assertTrue(
      "caret placement must perform the selection action",
      "targetNode.performAction(" in caret && "ACTION_SET_SELECTION," in caret,
    )
    val mutationCall = body.indexOf("mutate()")
    val selectionDecision = body.indexOf("val selectionSucceeded")
    val outcome = body.indexOf("insertTextOutcome(")
    val broadcast = body.indexOf("broadcastInsertTextResult(", startIndex = outcome)
    assertTrue(
      "mutation must attempt selection before returning",
      selection >= 0 && selectionAction > selection,
    )
    assertTrue(
      "outcome must follow the completed selection attempt",
      mutationCall >= 0 && selectionDecision > mutationCall && outcome > selectionDecision,
    )
    assertTrue("acknowledgement must include the computed outcome", broadcast > outcome)
    // The wire encoding (omitted optionals, partialApplication only when true) is pinned
    // byte-for-byte against the old hand-built frame in ResultFramesGoldenTest.
    // The broadcaster now forwards the result object; its fields are read by the frame builder.
    val frames =
      KotlinSourceScan.maskLiteralsAndComments(locateSource("ResultFrames.kt").readText())
    val broadcaster =
      functionBody(source, "private suspend fun broadcastInsertTextResult(") +
        frames.substring(
          frames.indexOf("internal fun insertTextResultFrame("),
          frames.indexOf("internal fun insertTextStateResultFrame("),
        )
    assertTrue(
      "insert acknowledgements must go through the shared result sender",
      "resultSender.sendFrame" in broadcaster,
    )
    assertResultSenderEnqueuesDirectly(
      KotlinSourceScan.maskLiteralsAndComments(readCtrlProxySource()),
    )
    assertTrue("must route through the typed frame", "insertTextResultFrame(" in broadcaster)
    for (field in
      listOf(
        "success",
        "totalTimeMs",
        "error",
        "warning",
        "caretPlaced",
        "resultingTextLength",
        "partialApplication",
      )) {
      assertTrue("$field must reach the typed frame", Regex("\\b$field\\b") in broadcaster)
    }
  }

  @Test
  fun `performInsertText acknowledges before asynchronously refreshing successful text mutations`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(readTextInputSource())
    val body = functionBody(source, "suspend fun apply()")
    val mutation = functionBody(source, "private suspend fun mutate()")
    val setText = mutation.indexOf("targetNode.performAction(")
    val mutationCall = body.indexOf("mutate()")
    val acknowledgement = body.indexOf("broadcastInsertTextResult(", startIndex = mutationCall)
    val refresh = body.indexOf("refreshHierarchyAfterTextInput()", startIndex = acknowledgement)
    val successfulMutationRefresh =
      body.indexOf("if (setTextSucceeded) refreshHierarchyAfterTextInput()")
    assertTrue("performInsertText must call ACTION_SET_TEXT", setText >= 0 && mutationCall >= 0)
    assertTrue(
      "insert_text_result must acknowledge the text mutation before hierarchy postprocessing",
      acknowledgement > mutationCall && refresh > acknowledgement,
    )
    assertTrue(
      "insert text must refresh changed text when caret restoration is only partially applied",
      successfulMutationRefresh > acknowledgement,
    )
  }

  /**
   * Acknowledgements must not wait on the backpressured event flow: the service's result transport
   * hands the frame to [WebSocketServer.broadcast], which enqueues it on each client directly.
   */
  private fun assertResultSenderEnqueuesDirectly(serviceSource: String) {
    assertTrue(
      "the result transport must reach the WebSocket server's direct broadcast",
      "webSocketServer.broadcast(frame)" in serviceSource,
    )
    val server =
      KotlinSourceScan.maskLiteralsAndComments(locateSource("WebSocketServer.kt").readText())
    assertTrue(
      "WebSocketServer.broadcast(message) must enqueue on each client directly",
      "broadcastToClients(message)" in
        functionBody(server, "suspend fun broadcast(message: String)"),
    )
  }

  private fun functionBody(source: String, signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) fail("$signature not found")
    val open = source.indexOf('{', start)
    if (open < 0) fail("$signature body not found")
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }

  private fun readCtrlProxySource(): String = locateSource("CtrlProxy.kt").readText()

  private fun readTextInputSource(): String = locateSource("TextInputController.kt").readText()

  private fun readGestureSource(): String = locateSource("GestureController.kt").readText()

  private fun locateSource(fileName: String): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/$fileName"
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
    fail("Could not locate $fileName from user.dir=${System.getProperty("user.dir")}")
    error("unreachable")
  }
}
