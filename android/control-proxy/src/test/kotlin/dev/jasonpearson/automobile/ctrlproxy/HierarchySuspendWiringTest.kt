package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Checks the service wiring which cannot be exercised without a live AccessibilityService. */
class HierarchySuspendWiringTest {
  @Test
  fun `explicit snapshots poll both command and service cancellation and preserve delivery cleanup`() {
    val body = functionBody("internal suspend fun extractHierarchyNow(", "HierarchyController.kt")
    assertTrue(body.contains("val commandJob = currentCoroutineContext()[Job]"))
    assertTrue(body.contains("snapshotOptions.isCancelled()"))
    assertTrue(body.contains("commandJob?.isActive == false"))
    assertTrue(body.contains("serviceScope.coroutineContext[Job]?.isActive == false"))
    assertTrue(body.contains("snapshotOptions = cancellableOptions"))
    assertTrue(body.contains("debouncer.extractImmediately("))
    assertTrue(
      body.contains("ImmediateHierarchyDelivery(requestId, commandJob).deliver(hierarchy)"),
    )
    val deliveryBody = functionBody("suspend fun deliver(hierarchy:", "HierarchyController.kt")
    val delivery = deliveryBody.indexOf("deliverHierarchyFrame(")
    val cancellation = deliveryBody.indexOf("commandJob?.ensureActive()")
    assertTrue("cancellation must occur inside delivery's cleanup guard", cancellation > delivery)
    assertTrue(deliveryBody.contains("releaseFrameContext ="))
    assertFalse(body.contains("runBlocking"))
  }

  @Test
  fun `direct extraction forwards snapshot cancellation to both window walkers`() {
    val entry = functionBody("private fun extractHierarchyDirect(", "HierarchyController.kt")
    assertTrue(
      entry
        .replace(Regex("\\s+"), "")
        .contains("HierarchyCapture(snapshotOptions.displayId).extractDirect("),
    )
    val body = functionBody("fun walkDirect(", "HierarchyController.kt")
    val extraction = functionBody("fun extractDirect(", "HierarchyController.kt")
    val walk = extraction.indexOf("walkDirect(disableAllFiltering, snapshotOptions)")
    assertTrue(walk >= 0)
    val allWindows = body.indexOf("viewHierarchyExtractor.extractFromAllWindows(")
    val activeWindow = body.indexOf("viewHierarchyExtractor.extractFromActiveWindow(")
    val firstForward = body.indexOf("snapshotOptions = snapshotOptions", allWindows)
    val secondForward = body.indexOf("snapshotOptions = snapshotOptions", activeWindow)
    assertTrue(firstForward in (allWindows + 1) until activeWindow)
    assertTrue(secondForward > activeWindow)
    val cancellation = extraction.indexOf("if (snapshotOptions.isCancelled())")
    val retainedContext = extraction.indexOf("extractedHierarchyFrameContexts[")
    assertTrue(cancellation > walk)
    assertTrue(retainedContext > cancellation)
  }

  @Test
  fun `text acknowledgement and async refresh use complete suspend paths`() {
    val entry = functionBody("suspend fun performSetText(", "TextInputController.kt")
    assertTrue(
      entry.contains("SetTextOperation(requestId, text, resourceId, dismissKeyboard).run()"),
    )
    val setText = functionBody("private inner class SetTextOperation(", "TextInputController.kt")
    assertFalse((entry + setText).contains("runBlocking"))
    assertTrue(setText.contains("broadcastSetTextResult("))
    val refresh =
      functionBody("private fun refreshHierarchyAfterTextInput()", "TextInputController.kt")
    assertTrue(refresh.contains("serviceScope.launch"))
    assertTrue(refresh.contains("host.publishSettledHierarchy()"))
    val publish = functionBody("override suspend fun publishSettledHierarchy()")
    assertTrue(publish.contains("hierarchyController.publishSettledHierarchy()"))
    val settledPublish =
      functionBody("fun HierarchyController.publishSettledHierarchy()", "HierarchyController.kt")
    assertTrue(settledPublish.contains("settledHierarchy()"))
    assertFalse(settledPublish.contains("runBlocking"))
  }

  private fun functionBody(signature: String, fileName: String = "CtrlProxy.kt"): String {
    val relative = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/$fileName"
    val file =
      listOf(
          File(relative),
          File("control-proxy/$relative"),
          File("android/control-proxy/$relative"),
        )
        .first { it.isFile }
    val source = KotlinSourceScan.maskLiteralsAndComments(file.readText())
    val start = source.indexOf(signature)
    check(start >= 0) { "$signature not found" }
    val open = source.indexOf('{', start)
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }
}
