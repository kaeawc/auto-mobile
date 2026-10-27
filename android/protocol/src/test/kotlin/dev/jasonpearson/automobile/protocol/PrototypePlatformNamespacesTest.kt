package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PrototypePlatformNamespacesTest {
  @Test
  fun `retain Android node fields and strip foreign window and theme namespaces`() {
    val input =
      Json.parseToJsonElement(
        """{"window":{"ios":{},"android":{},"opacity":100},"theme":{"ios":{}},"data":{"ios":{"hover":"lift"}},"root":{"type":"stack","ios":{},"screens":{"home":{"type":"column","android":{},"children":[{"type":"text","ios":{},"text":"Hi","repeat":{"items":[{"ios":1}]}}]}}}}""",
      )
    val expected =
      Json.parseToJsonElement(
        """{"window":{"opacity":100},"data":{"ios":{"hover":"lift"}},"root":{"type":"stack","screens":{"home":{"type":"column","android":{},"children":[{"type":"text","text":"Hi","repeat":{"items":[{"ios":1}]}}]}}}}""",
      )
    assertEquals(expected, stripPlatformNamespaces(input))
    // A theme that held only a namespace is dropped: an empty theme is invalid.
    assertNull(stripPlatformNamespaces(input).jsonObject["theme"])
  }
}
