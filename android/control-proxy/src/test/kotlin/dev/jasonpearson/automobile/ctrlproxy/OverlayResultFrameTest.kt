package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.OverlayResult
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlayStatusEntry
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayResultFrameTest {
  private val json = Json { classDiscriminator = "type" }

  @Test
  fun `a result without missing assets keeps the frame legacy peers expect`() {
    val frame = json.parseToJsonElement(overlayResultFrame("r1", true, null)).jsonObject
    assertFalse("missingAssets" in frame)
    assertFalse("overlays" in frame)
    assertFalse("droppedEvents" in frame)
    assertEquals(setOf("type", "timestamp", "requestId", "success", "error"), frame.keys)
  }

  @Test
  fun `an inspect reply carries the overlays and the dropped count on the result frame`() {
    val entry =
      OverlayStatusEntry(
        id = "proto",
        persistent = true,
        state = mapOf("label" to OverlayScalar.Text("typed")),
        pages = mapOf("pager" to 1),
        lastSequence = 7,
      )
    val frame = overlayStatusFrame("r9", listOf(entry), 3)
    val parsed = json.parseToJsonElement(frame).jsonObject
    assertEquals(JsonPrimitive("overlay_result"), parsed["type"])
    assertEquals(JsonPrimitive("r9"), parsed["requestId"])
    assertEquals(JsonPrimitive(3), parsed["droppedEvents"])
    val decoded = json.decodeFromString<WebSocketResponse>(frame) as OverlayResult
    assertEquals(listOf(entry), decoded.overlays)
    assertTrue(decoded.success)
  }

  @Test
  fun `missing asset ids ride the same frame as a warning`() {
    val frame = overlayResultFrame("r1", true, null, listOf("hero", "logo"))
    val parsed = json.parseToJsonElement(frame).jsonObject
    assertEquals(
      JsonArray(listOf(JsonPrimitive("hero"), JsonPrimitive("logo"))),
      parsed["missingAssets"],
    )
    assertEquals(JsonPrimitive(true), parsed["success"])
    val decoded = json.decodeFromString<WebSocketResponse>(frame) as OverlayResult
    assertEquals(listOf("hero", "logo"), decoded.missingAssets)
    assertTrue(decoded.success)
  }
}
