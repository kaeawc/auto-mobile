package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.OverlayResult
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
    assertEquals(setOf("type", "timestamp", "requestId", "success", "error"), frame.keys)
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
