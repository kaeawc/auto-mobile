package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeEventFrameTest {
  @Test
  fun `emit frame exactly matches protocol literal and has no request id`() {
    val literal =
      """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":1,"kind":"emit","name":"next","payload":{"nested":[true,null]},"state":{"label":"Next","enabled":true},"pages":{"pager":0}}"""
    val event =
      PrototypeEvent(
        42,
        "panel",
        1,
        PrototypeEventKind.EMIT,
        "next",
        Json.parseToJsonElement("""{"nested":[true,null]}"""),
        mapOf(
          "label" to PrototypeScalar.Text("Next"),
          "enabled" to PrototypeScalar.BooleanValue(true),
        ),
        mapOf("pager" to 0),
      )
    assertEquals(literal, prototypeEventFrame(event))
    assertFalse(
      Json.parseToJsonElement(prototypeEventFrame(event)).jsonObject.containsKey("requestId"),
    )
  }

  @Test
  fun `page and dismiss frames match protocol null name payload literals`() {
    for ((kind, name) in
      listOf(
        PrototypeEventKind.PAGE_CHANGED to "page_changed",
        PrototypeEventKind.DISMISSED to "dismissed",
      )) {
      val literal =
        """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":2,"kind":"$name","name":null,"payload":null,"state":{},"pages":{}}"""
      assertEquals(
        literal,
        prototypeEventFrame(PrototypeEvent(42, "panel", 2, kind, null, null, emptyMap())),
      )
    }
  }

  @Test
  fun `change frame carries key value current scalars pages and sequence`() {
    val event =
      PrototypeEvent(
        42,
        "panel",
        3,
        PrototypeEventKind.EMIT,
        "change",
        Json.parseToJsonElement("""{"key":"query","value":"typed"}"""),
        mapOf("query" to PrototypeScalar.Text("typed")),
        mapOf("pager" to 1),
      )
    val literal =
      """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":3,"kind":"emit","name":"change","payload":{"key":"query","value":"typed"},"state":{"query":"typed"},"pages":{"pager":1}}"""
    assertEquals(literal, prototypeEventFrame(event))
  }
}
