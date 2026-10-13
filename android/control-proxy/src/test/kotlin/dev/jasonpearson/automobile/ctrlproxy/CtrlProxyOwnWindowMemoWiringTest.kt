package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test

/** Android-free source guards for own-window memo wiring (#12134). */
class CtrlProxyOwnWindowMemoWiringTest {

  @Test
  fun `events invalidate before filtering and keep binder and state reads lazy`() {
    val body = functionBody(source, "overridefunonAccessibilityEvent(")
    val invalidate = body.indexOf("invalidateOwnWindowTypeMemo(event)")
    val decision = body.indexOf("ownWindowEventDecision(")
    assertTrue("Events must invalidate the memo before filtering", invalidate >= 0)
    assertTrue("Events must use the own-window filter after invalidation", decision > invalidate)
    val decisionOpen = body.indexOf('(', decision)
    val arguments = body.substring(decisionOpen, KotlinSourceScan.matchParen(body, decisionOpen))
    assertOnlyInLambda(body, functionBody(arguments, "resolve={"), "ownEventWindowType(event)")
    assertOnlyInLambda(body, functionBody(arguments, "appLayerShowing={"), "isAppLayerShowing")
  }

  @Test
  fun `foreground tracking uses the positive memo with a lazy resolver`() {
    val body = functionBody(source, "privatefuntrackPrototypeForeground(")
    val memoCall = "ownWindowTypeMemo.windowType("
    val start = body.indexOf(memoCall)
    assertTrue("Foreground tracking must use the window-type memo", start >= 0)
    val open = body.indexOf('(', start)
    val arguments = body.substring(open, KotlinSourceScan.matchParen(body, open))
    assertTrue(
      "Foreground tracking must retry unresolved windows immediately",
      "retryUnresolvedImmediately=true" in arguments,
    )
    assertOnlyInLambda(body, functionBody(body, memoCall), "ownEventWindowType(event)")
  }

  @Test
  fun `prototype attachment and dismissal clear the memo`() {
    for (signature in listOf("onWindowAttached={", "onDismissed={")) {
      assertTrue(
        "$signature must clear cached window types",
        "ownWindowTypeMemo.clear()" in functionBody(source, signature),
      )
    }
  }

  private fun assertOnlyInLambda(body: String, lambda: String, token: String) {
    assertEquals("$token must appear exactly once", 1, body.split(token).size - 1)
    assertTrue("$token must remain inside its lazy lambda", token in lambda)
  }

  private fun functionBody(source: String, signature: String): String {
    val start = source.indexOf(signature)
    if (start < 0) fail("$signature not found in CtrlProxy.kt")
    val open = source.indexOf('{', start)
    if (open < 0) fail("$signature body not found in CtrlProxy.kt")
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
  }

  companion object {
    private lateinit var source: String

    @BeforeClass
    @JvmStatic
    fun loadSource() {
      source =
        KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
          .filterNot { it.isWhitespace() }
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
