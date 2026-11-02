package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Android-free source guard: onServiceConnected runs each startup step once, in order. */
class CtrlProxyServiceStartupWiringTest {

  @Test
  fun `onServiceConnected runs each startup step once and in order`() {
    val body = onServiceConnectedBody()
    val steps =
      listOf(
        "createPrototypeController()",
        "prototypeAssets.purgeLeftovers()",
        "hierarchyController.start()",
        "startStorageSubscription()",
        "startWebSocketServer()",
        "startEventIngestion()",
        "startLogcatForwarding()",
      )
    for (step in steps) {
      assertEquals("$step must run exactly once", 1, body.split(step).size - 1)
    }
    val positions = steps.map(body::indexOf)
    assertEquals("startup steps must run in this order", positions.sorted(), positions)
  }

  @Test
  fun `the prototype controller is created only when not already initialized`() {
    val body = onServiceConnectedBody()
    val guard = body.indexOf("if(!::prototypeController.isInitialized){")
    assertTrue("prototype creation must stay behind its initialization guard", guard >= 0)
    val guarded = body.substring(guard, KotlinSourceScan.matchBrace(body, body.indexOf('{', guard)))
    assertTrue(
      "the controller is created inside the guard",
      "prototypeController=createPrototypeController()" in guarded,
    )
  }

  private fun onServiceConnectedBody(): String {
    val source =
      KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText()).filterNot {
        it.isWhitespace()
      }
    val start = source.indexOf("overridefunonServiceConnected(")
    if (start < 0) fail("onServiceConnected not found in CtrlProxy.kt")
    val open = source.indexOf('{', start)
    return source.substring(open, KotlinSourceScan.matchBrace(source, open))
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
