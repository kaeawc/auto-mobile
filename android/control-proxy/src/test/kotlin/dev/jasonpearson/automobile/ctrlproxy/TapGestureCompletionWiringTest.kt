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
    get() = maskedSource

  @Test
  fun `every gesture dispatch supplies the dedicated callback handler`() {
    val calls = Regex("\\bdispatchGesture\\s*\\(").findAll(source).toList()
    assertEquals("Guard every CtrlProxy dispatchGesture call site", 2, calls.size)

    for (call in calls) {
      val open = source.indexOf('(', call.range.first)
      val args = source.substring(open + 1, KotlinSourceScan.matchParen(source, open) - 1)
      assertTrue(
        "dispatchGesture at line ${KotlinSourceScan.lineOf(source, open)} must pass gestureHandler",
        Regex(",\\s*gestureHandler\\s*,?\\s*$").containsMatchIn(args),
      )
    }
  }

  @Test
  fun `tap settles off main and queues hierarchy before tap result`() {
    val dispatchBody = functionBody("private fun dispatchGestureWithResult(")
    assertTrue(
      "completion must run beforeResult before onResult",
      "lifecycle.completed(beforeResult = beforeCompletedResult, onResult = onResult)" in
        dispatchBody,
    )

    val tapBody = functionBody("private fun performTapCoordinates(")
    val beforeStart = tapBody.indexOf("beforeCompletedResult = {")
    assertTrue("tap must provide completion work", beforeStart >= 0)
    val beforeOpen = tapBody.indexOf('{', beforeStart)
    val beforeBody = tapBody.substring(beforeOpen, KotlinSourceScan.matchBrace(tapBody, beforeOpen))
    assertTrue(
      "tap must extract after quiescence",
      "hierarchyDebouncer.extractAfterQuiescence(" in beforeBody,
    )
    assertFalse("tap completion must not runBlocking", "runBlocking" in beforeBody)

    val successBranch = tapBody.substring(tapBody.indexOf("if (outcome.completed)"))
    val hierarchy = successBranch.indexOf("broadcastHierarchyUpdate(it, sync = true)")
    val tapResult = successBranch.indexOf("broadcastTapCoordinatesResult(requestId, true,")
    assertTrue(
      "tap result must follow the hierarchy update in one request coroutine",
      hierarchy >= 0 && tapResult > hierarchy,
    )
    assertTrue(
      "success must use request-correlated background work",
      successBranch.indexOf("launchRequestScope(requestId)") < hierarchy,
    )
  }

  private fun functionBody(signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) fail("$signature not found in CtrlProxy.kt")
    val parametersOpen = source.indexOf('(', start)
    val open = source.indexOf('{', KotlinSourceScan.matchParen(source, parametersOpen))
    if (open < 0) fail("$signature body not found in CtrlProxy.kt")
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }

  companion object {
    private lateinit var maskedSource: String

    @BeforeClass
    @JvmStatic
    fun loadSource() {
      maskedSource = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    }

    private fun locateCtrlProxySource(): File {
      val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
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
}
