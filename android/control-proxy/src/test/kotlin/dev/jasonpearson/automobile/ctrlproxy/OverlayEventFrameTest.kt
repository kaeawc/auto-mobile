package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OverlayEventFrameTest {
  @Test
  fun `emit frame exactly matches protocol literal and has no request id`() {
    val literal =
      """{"type":"overlay_event","timestamp":42,"id":"panel","sequence":1,"kind":"emit","name":"next","payload":{"nested":[true,null]},"state":{"label":"Next","enabled":true},"pages":{"pager":0}}"""
    val event =
      OverlayEvent(
        42,
        "panel",
        1,
        OverlayEventKind.EMIT,
        "next",
        Json.parseToJsonElement("""{"nested":[true,null]}"""),
        mapOf("label" to OverlayScalar.Text("Next"), "enabled" to OverlayScalar.BooleanValue(true)),
        mapOf("pager" to 0),
      )
    assertEquals(literal, overlayEventFrame(event))
    assertFalse(
      Json.parseToJsonElement(overlayEventFrame(event)).jsonObject.containsKey("requestId")
    )
  }

  @Test
  fun `page and dismiss frames match protocol null name payload literals`() {
    for ((kind, name) in
      listOf(
        OverlayEventKind.PAGE_CHANGED to "page_changed",
        OverlayEventKind.DISMISSED to "dismissed",
      )) {
      val literal =
        """{"type":"overlay_event","timestamp":42,"id":"panel","sequence":2,"kind":"$name","name":null,"payload":null,"state":{},"pages":{}}"""
      assertEquals(
        literal,
        overlayEventFrame(OverlayEvent(42, "panel", 2, kind, null, null, emptyMap())),
      )
    }
  }

  @Test
  fun `change frame carries key value current scalars pages and sequence`() {
    val event =
      OverlayEvent(
        42,
        "panel",
        3,
        OverlayEventKind.EMIT,
        "change",
        Json.parseToJsonElement("""{"key":"query","value":"typed"}"""),
        mapOf("query" to OverlayScalar.Text("typed")),
        mapOf("pager" to 1),
      )
    val literal =
      """{"type":"overlay_event","timestamp":42,"id":"panel","sequence":3,"kind":"emit","name":"change","payload":{"key":"query","value":"typed"},"state":{"query":"typed"},"pages":{"pager":1}}"""
    assertEquals(literal, overlayEventFrame(event))
  }
}
