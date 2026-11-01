package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test

/** Source guard for gesture callback threading and tap acknowledgement order (#6445). */
class TapGestureCompletionWiringTest {
  private val source: String
    get() = maskedGestureSource

  @Test
  fun `every gesture dispatch supplies the dedicated callback handler`() {
    val calls = Regex("\\bhost\\.dispatchGesture\\s*\\(").findAll(source).toList()
    assertEquals("Guard every GestureController dispatchGesture call site", 2, calls.size)

    for (call in calls) {
      val open = source.indexOf('(', call.range.first)
      val args = source.substring(open + 1, KotlinSourceScan.matchParen(source, open) - 1)
      assertTrue(
        "dispatchGesture at line ${KotlinSourceScan.lineOf(source, open)} must pass gestureHandler",
        Regex(",\\s*gestureHandler\\s*,?\\s*$").containsMatchIn(args),
      )
    }
    // The service's Host forwards the controller's handler to the framework unchanged.
    assertTrue(
      "CtrlProxy's GestureController.Host must pass the handler through to dispatchGesture",
      "this@CtrlProxy.dispatchGesture(gesture, callback, handler)" in maskedServiceSource,
    )
  }

  @Test
  fun `tap settles off main and queues hierarchy before tap result`() {
    assertCompletionDispatch()
    assertTapHierarchyOrder()
  }

  private fun assertCompletionDispatch() {
    val dispatchBody = functionBody("private fun dispatchGestureWithResult(")
    val compactBody = dispatchBody.filterNot { it.isWhitespace() }
    val correlatedLaunch =
      Regex(
        Regex.escape(
          "serviceScope.launch(gestureHandler.asCoroutineDispatcher().immediate+" +
            "RequestIdContext(requestId)+PerfRequestContext(requestId)",
        ) + ",?\\)",
      )
    assertTrue(
      "completion must remain on the gesture handler and carry request correlation",
      correlatedLaunch.containsMatchIn(compactBody),
    )
    assertEquals(
      "onCompleted and onCancelled must both stay on the gesture handler and carry request correlation",
      2,
      correlatedLaunch.findAll(compactBody).count(),
    )
    assertEquals(
      "completed and cancelled callbacks must share FIFO serialization while settling suspends",
      2,
      Regex("gestureCompletionMutex\\.withLock").findAll(dispatchBody).count(),
    )
    assertTrue(
      "completion must run beforeResult before onResult",
      "lifecycle.completed(beforeResult = beforeCompletedResult, onResult = onResult)" in
        dispatchBody,
    )
  }

  private fun assertTapHierarchyOrder() {
    val tapBody = functionBody("fun performTapCoordinates(")
    val beforeStart = tapBody.indexOf("beforeCompletedResult = {")
    assertTrue("tap must provide completion work", beforeStart >= 0)
    val beforeOpen = tapBody.indexOf('{', beforeStart)
    val beforeBody = tapBody.substring(beforeOpen, KotlinSourceScan.matchBrace(tapBody, beforeOpen))
    assertTrue(
      "tap must extract after quiescence",
      "host.settledHierarchy(displayId)" in beforeBody,
    )
    val settled = maskedServiceSource.indexOf("override suspend fun settledHierarchy(")
    assertTrue(
      "the service's settled hierarchy must wait for quiescence on the requested display",
      settled >= 0 &&
        maskedServiceSource
          .substring(settled, maskedServiceSource.indexOf("override suspend fun publishHierarchy("))
          .let { "hierarchyController.settledHierarchy(displayId)" in it },
    )
    assertTrue(
      "the settled hierarchy must wait for quiescence on the requested display",
      maskedHierarchySource
        .substringAfter("fun settledHierarchy(")
        .substringBefore("fun broadcastHierarchyUpdate(")
        .let {
          "debouncer.extractAfterQuiescenceSuspending(" in it &&
            "HierarchySnapshotOptions(displayId = displayId)" in it
        },
    )
    assertTrue(
      "the service must publish the settled hierarchy synchronously",
      Regex(
          "override suspend fun publishHierarchy\\(hierarchy: ViewHierarchy\\)\\s*=\\s*" +
            "hierarchyController\\.broadcastHierarchyUpdate\\(hierarchy, sync = true\\)",
        )
        .containsMatchIn(maskedServiceSource),
    )
    assertFalse("tap completion must not runBlocking", "runBlocking" in beforeBody)

    val successBranch = tapBody.substring(tapBody.indexOf("if (outcome.completed)"))
    val hierarchy = successBranch.indexOf("host.publishHierarchy(it)")
    val tapResult = successBranch.indexOf("broadcastTapCoordinatesResult(requestId, true,")
    assertTrue(
      "tap result must follow the hierarchy update in one request coroutine",
      hierarchy >= 0 && tapResult > hierarchy,
    )
    assertTrue(
      "success must use request-correlated background work",
      successBranch.indexOf("host.launchRequestScope(requestId)") < hierarchy,
    )
  }

  private fun functionBody(signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) fail("$signature not found in GestureController.kt")
    val parametersOpen = source.indexOf('(', start)
    val open = source.indexOf('{', KotlinSourceScan.matchParen(source, parametersOpen))
    if (open < 0) fail("$signature body not found in GestureController.kt")
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }

  companion object {
    private lateinit var maskedGestureSource: String
    private lateinit var maskedServiceSource: String
    private lateinit var maskedHierarchySource: String

    @BeforeClass
    @JvmStatic
    fun loadSource() {
      maskedGestureSource =
        KotlinSourceScan.maskLiteralsAndComments(locateSource("GestureController.kt").readText())
      maskedServiceSource =
        KotlinSourceScan.maskLiteralsAndComments(locateSource("CtrlProxy.kt").readText())
      maskedHierarchySource =
        KotlinSourceScan.maskLiteralsAndComments(locateSource("HierarchyController.kt").readText())
    }

    private fun locateSource(fileName: String): File {
      val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/$fileName"
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
}
