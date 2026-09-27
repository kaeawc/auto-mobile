package dev.jasonpearson.automobile.discover.ictrace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IcTraceFormatterTest {
  private fun event(seq: Int, call: String = "commitText", args: String = "text=\"hello\"") =
    IcTraceEvent(seq, 12L, call, args, 1, 2, -1, -1)

  @Test
  fun `formats one object per line with stable keys`() {
    val lines = IcTraceFormatter.format(listOf(event(1), event(2, "setSelection"))).lines()
    assertEquals(2, lines.size)
    val keys =
      listOf(
        "seq",
        "elapsedMs",
        "call",
        "args",
        "selectionStart",
        "selectionEnd",
        "composingStart",
        "composingEnd",
        "result",
        "readValue",
        "droppedEvents",
        "metadata",
      )
    lines.forEach { line ->
      assertTrue(line.startsWith("{"))
      assertTrue(line.endsWith("}"))
      val positions = keys.map { line.indexOf("\"$it\":") }
      assertTrue(positions.all { it >= 0 })
      assertEquals(positions.sorted(), positions)
      assertFalse(line.startsWith("["))
    }
  }

  @Test
  fun `escapes text and control characters without truncation`() {
    val formatted = IcTraceFormatter.format(listOf(event(1, args = "text=\"a\\b\n\u0001\"")))
    assertTrue(formatted.contains("a\\\\b\\n\\u0001"))
    assertFalse(formatted.contains('\n'))
    assertFalse(formatted.contains('\u0001'))
  }

  @Test
  fun `summarizes each call`() {
    assertEquals(
      "commitText: 2\nsetSelection: 1",
      IcTraceFormatter.summary(listOf(event(1), event(2, "setSelection"), event(3))),
    )
  }

  @Test
  fun `includes outcome and metadata while preserving jsonl objects`() {
    val value =
      event(1)
        .copy(
          result = false,
          readValue = "text=\"line\\nvalue\"",
          droppedEvents = 2,
          metadata = IcTraceMetadata(scenario = "scenario\"one", keyboardId = "pkg/.Ime"),
        )
    val line = IcTraceFormatter.format(listOf(value))
    assertTrue(line.contains("\"result\":false"))
    assertTrue(line.contains("\"droppedEvents\":2"))
    assertTrue(line.contains("\"scenario\":\"scenario\\\"one\""))
    assertTrue(line.contains("\"keyboardId\":\"pkg/.Ime\""))
    assertTrue(line.startsWith("{") && line.endsWith("}"))
  }
}
