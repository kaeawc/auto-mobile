package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Checks the service wiring which cannot be exercised without a live AccessibilityService. */
class HierarchySuspendWiringTest {
  @Test
  fun `explicit snapshots poll both command and service cancellation and preserve delivery cleanup`() {
    val body = functionBody("private suspend fun extractHierarchyNow(")
    assertTrue(body.contains("val commandJob = currentCoroutineContext()[Job]"))
    assertTrue(body.contains("snapshotOptions.isCancelled()"))
    assertTrue(body.contains("commandJob?.isActive == false"))
    assertTrue(body.contains("serviceScope.coroutineContext[Job]?.isActive == false"))
    assertTrue(body.contains("snapshotOptions = cancellableOptions"))
    assertTrue(body.contains("hierarchyDebouncer.extractImmediately("))
    val delivery = body.indexOf("deliverHierarchyFrame(")
    val cancellation = body.indexOf("commandJob?.ensureActive()")
    assertTrue("cancellation must occur inside delivery's cleanup guard", cancellation > delivery)
    assertTrue(body.contains("releaseFrameContext ="))
    assertFalse(body.contains("runBlocking"))
  }

  @Test
  fun `direct extraction forwards snapshot cancellation to both window walkers`() {
    val body = functionBody("private fun extractHierarchyDirect(")
    val allWindows = body.indexOf("viewHierarchyExtractor.extractFromAllWindows(")
    val activeWindow = body.indexOf("viewHierarchyExtractor.extractFromActiveWindow(")
    val firstForward = body.indexOf("snapshotOptions = snapshotOptions", allWindows)
    val secondForward = body.indexOf("snapshotOptions = snapshotOptions", activeWindow)
    assertTrue(firstForward in (allWindows + 1) until activeWindow)
    assertTrue(secondForward > activeWindow)
    val cancellation = body.indexOf("if (snapshotOptions.isCancelled())")
    val retainedContext = body.indexOf("extractedHierarchyFrameContexts[")
    assertTrue(cancellation > secondForward)
    assertTrue(retainedContext > cancellation)
  }

  @Test
  fun `text acknowledgement and async refresh use complete suspend paths`() {
    val setText = functionBody("private suspend fun performSetText(")
    assertFalse(setText.contains("runBlocking"))
    assertTrue(setText.contains("broadcastSetTextResult("))
    val refresh = functionBody("private fun refreshHierarchyAfterTextInput()")
    assertTrue(refresh.contains("serviceScope.launch"))
    assertTrue(refresh.contains("hierarchyDebouncer.extractAfterQuiescenceSuspending("))
  }

  private fun functionBody(signature: String): String {
    val relative = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
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
