package dev.jasonpearson.automobile.desktop.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Regression guard for #3603: the take-screenshot action must run on a composition-scoped coroutine
 * (`rememberCoroutineScope`) rather than `GlobalScope`, so the call and its MCP client are
 * cancelled when the composable leaves composition instead of leaking a hung coroutine + client.
 *
 * Compose interaction is impractical to unit test here, so this asserts the invariant at the source
 * level (per the issue's suggested source-scan strategy).
 */
class ScreenshotActionScopeTest {
  private val source =
    Path.of("src/main/kotlin/dev/jasonpearson/automobile/desktop/core/AutoMobileContent.kt").let {
      assertTrue(Files.exists(it), "$it should exist")
      Files.readString(it)
    }

  @Test
  fun `screenshot action is launched on the composition scope, not GlobalScope`() {
    val marker = "callTool(\"screenshot\""
    val occurrences = source.indicesOf(marker)
    assertTrue(occurrences.isNotEmpty(), "the screenshot handler should still exist")

    occurrences.forEach { idx ->
      val preceding = source.substring(maxOf(0, idx - 400), idx)
      assertTrue(
        preceding.contains("screenshotScope.launch"),
        "the screenshot callTool must be launched on the composition-scoped screenshotScope (#3603)",
      )
      assertFalse(
        preceding.contains("GlobalScope"),
        "the screenshot callTool must not run on GlobalScope (#3603)",
      )
    }
  }

  @Test
  fun `screenshot scope is bound to rememberCoroutineScope`() {
    assertTrue(
      source.contains("val screenshotScope = rememberCoroutineScope()"),
      "screenshot work must be tied to a composition-scoped coroutine (#3603)",
    )
  }

  @Test
  fun `screenshot handler is defined once and shared by both menus`() {
    // Both the native menu bar and the in-app menu route through the single shared lambda, so the
    // screenshot callTool appears exactly once.
    assertEquals(
      1,
      source.indicesOf("callTool(\"screenshot\"").size,
      "the two screenshot entry points should share one handler",
    )
  }

  private fun String.indicesOf(needle: String): List<Int> {
    val result = mutableListOf<Int>()
    var from = indexOf(needle)
    while (from >= 0) {
      result.add(from)
      from = indexOf(needle, from + needle.length)
    }
    return result
  }
}
