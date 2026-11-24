package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeWebViewWiringTest {
  private val android =
    generateSequence(File(".").canonicalFile) { it.parentFile }
      .map { it.resolve("android") }
      .first { it.resolve("settings.gradle.kts").isFile }

  @Test
  fun rendererIsWiredWithoutScriptBridges() {
    val source =
      android.resolve(
        "prototype-compose/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/prototype",
      )
    assertTrue(
      source.resolve("PrototypeSpecContent.kt").readText().contains("RenderPrototypeWebView("),
    )
    for (name in listOf("PrototypeWebViewContent.kt", "PrototypeWebViewClient.kt")) {
      val renderer = source.resolve(name).readText()
      for (forbidden in listOf("addJavascriptInterface", "evaluateJavascript", "\"javascript:")) {
        assertFalse("$name contains $forbidden", forbidden in renderer)
      }
    }
  }

  @Test
  fun viewerRegistersModuleAndOverlayDoesNot() {
    val module = "PrototypeWebViewModule"
    assertTrue(
      android.resolve("protoviewer/src/main").walkTopDown().any {
        it.name == "ViewerActivity.kt" && it.readText().contains(module)
      },
    )
    assertFalse(
      android.resolve("control-proxy/src/main").walkTopDown().any {
        it.extension == "kt" && it.readText().contains(module)
      },
    )
  }
}
