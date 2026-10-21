package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BaselineProfileTest {
  @Test
  fun `baseline profile has valid rules and covers manifest components`() {
    val rules =
      File("src/main/baseline-prof.txt")
        .readLines()
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }

    rules.forEach { rule ->
      assertTrue("Malformed baseline profile rule: $rule", RULE.matches(rule))
    }
    MANIFEST_COMPONENTS.forEach { component ->
      assertTrue(
        "Missing baseline profile rule for manifest component: $component",
        rules.any { it.substringAfter('L').substringBefore(';') == component },
      )
    }
  }

  private companion object {
    val RULE =
      Regex(
        """H?S?P?L[A-Za-z0-9_${'$'}*?]+(?:/[A-Za-z0-9_${'$'}*?]+)*;(?:->[A-Za-z0-9_${'$'}<>*?]+\([A-Za-z0-9_${'$'}/;\[*?]*\)[A-Za-z0-9_${'$'}/;\[*?]+)?""",
      )
    // Exact descriptors from src/main/AndroidManifest.xml, resolved against the module namespace.
    val MANIFEST_COMPONENTS =
      listOf(
        "dev/jasonpearson/automobile/ctrlproxy/CtrlProxy",
        "dev/jasonpearson/automobile/ctrlproxy/MainActivity",
        "dev/jasonpearson/automobile/ctrlproxy/ime/CtrlProxyIme",
        "dev/jasonpearson/automobile/ctrlproxy/prototype/SavedPrototypeActivity",
        "dev/jasonpearson/automobile/ctrlproxy/AutoMobileDeviceAdminReceiver",
      )
  }
}
