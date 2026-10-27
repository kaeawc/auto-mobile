package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeContentTransitionTest {
  @Test
  fun `typed text field decodes`() {
    val node =
      Json.decodeFromString(
        PrototypeNode.serializer(),
        """{"type":"text","text":"9","contentTransition":"numeric"}""",
      ) as PrototypeTextNode
    assertEquals("numeric", node.contentTransition)
  }

  @Test
  fun `direction follows resolved values`() {
    for ((before, after, expected) in
      listOf(
        Triple("9", "10", "up"),
        Triple("$1,200", "$980", "down"),
        Triple("abc", "abd", "crossfade"),
        Triple("-3.5", "-2.5", "up"),
        Triple("1.2", "1.1", "down"),
        Triple("9", "9", "crossfade"),
        Triple("09", "9", "crossfade"),
        Triple("0", "-1", "down"),
      )) assertEquals(expected, contentTransitionDirection(before, after))
  }

  @Test
  fun `parse strips formatting and retains first decimal and leading minus`() {
    assertEquals(1200.0, parseContentTransitionNumber("$1,200"))
    assertEquals(-3.5, parseContentTransitionNumber("-3.5"))
    assertEquals(1.23, parseContentTransitionNumber("1.2.3"))
    assertNull(parseContentTransitionNumber("abc"))
  }
}
