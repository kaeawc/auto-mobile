package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import dev.jasonpearson.automobile.protocol.PrototypePatchConflict
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeResultFrameTest {
  private val json = Json { classDiscriminator = "type" }

  @Test
  fun `patch conflict carries revision and scalar state in the same result frame`() {
    val conflict = PrototypePatchConflict(8L, mapOf("flag" to PrototypeScalar.BooleanValue(true)))
    val frame = prototypeResultFrame("patch", false, "conflict", revision = 8L, conflict = conflict)
    val parsed = json.parseToJsonElement(frame).jsonObject
    assertEquals(JsonPrimitive(8L), parsed["revision"])
    assertEquals(
      json.parseToJsonElement("""{"revision":8,"state":{"flag":true}}"""),
      parsed["conflict"],
    )
    val decoded = json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
    assertEquals(conflict, decoded.conflict)
    assertFalse(decoded.success)
    val success =
      json.parseToJsonElement(prototypeResultFrame("patch", true, null, revision = 9L)).jsonObject
    assertEquals(JsonPrimitive(9L), success["revision"])
    assertFalse("conflict" in success)
  }

  @Test
  fun `show result forwards hidden reason while legacy result omits it`() {
    for (reason in PrototypeHiddenReason.entries) {
      val frame = prototypeResultFrame("show", true, null, hiddenReason = reason)
      val result = json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
      assertEquals(reason, result.hiddenReason)
    }
    val frame = prototypeResultFrame("legacy", true, null)
    assertFalse("hiddenReason" in json.parseToJsonElement(frame).jsonObject)
    assertNull((json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult).hiddenReason)
  }

  @Test
  fun `hierarchy hidden reason is optional even when defaults are encoded`() {
    val legacy = """{"updatedAt":42}"""
    val hierarchy = ViewHierarchy(updatedAt = 42)
    assertEquals(legacy, json.encodeToString(ViewHierarchy.serializer(), hierarchy))
    assertNull(json.decodeFromString(ViewHierarchy.serializer(), legacy).prototypeHiddenReason)
    val defaults = Json { encodeDefaults = true }
    assertFalse(
      "prototypeHiddenReason" in
        defaults.encodeToJsonElement(ViewHierarchy.serializer(), hierarchy).jsonObject,
    )
    for ((reason, wire) in
      listOf(
        PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN to "app_layer_window_hidden",
        PrototypeHiddenReason.DEVICE_BLOCKED to "device_blocked",
      )) {
      val frame =
        json.encodeToString(
          ViewHierarchy.serializer(),
          hierarchy.copy(prototypeHiddenReason = reason),
        )
      assertEquals(legacy.dropLast(1) + ",\"prototypeHiddenReason\":\"$wire\"}", frame)
      assertEquals(
        reason,
        json.decodeFromString(ViewHierarchy.serializer(), frame).prototypeHiddenReason,
      )
    }
  }

  @Test
  fun `a result without missing assets keeps the frame legacy peers expect`() {
    val frame = json.parseToJsonElement(prototypeResultFrame("r1", true, null)).jsonObject
    assertFalse("missingAssets" in frame)
    assertFalse("prototypes" in frame)
    assertFalse("droppedEvents" in frame)
    assertEquals(setOf("type", "timestamp", "requestId", "success", "error"), frame.keys)
  }

  @Test
  fun `an inspect reply carries the prototypes and the dropped count on the result frame`() {
    val entry =
      PrototypeStatusEntry(
        id = "proto",
        persistent = true,
        state = mapOf("label" to PrototypeScalar.Text("typed")),
        pages = mapOf("pager" to 1),
        lastSequence = 7,
      )
    val frame = prototypeStatusFrame("r9", listOf(entry), 3)
    val parsed = json.parseToJsonElement(frame).jsonObject
    assertEquals(JsonPrimitive("prototype_result"), parsed["type"])
    assertEquals(JsonPrimitive("r9"), parsed["requestId"])
    assertEquals(JsonPrimitive(3), parsed["droppedEvents"])
    val decoded = json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
    assertEquals(listOf(entry), decoded.prototypes)
    assertTrue(decoded.success)
  }

  @Test
  fun `missing asset ids ride the same frame as a warning`() {
    val frame = prototypeResultFrame("r1", true, null, listOf("hero", "logo"))
    val parsed = json.parseToJsonElement(frame).jsonObject
    assertEquals(
      JsonArray(listOf(JsonPrimitive("hero"), JsonPrimitive("logo"))),
      parsed["missingAssets"],
    )
    assertEquals(JsonPrimitive(true), parsed["success"])
    val decoded = json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
    assertEquals(listOf("hero", "logo"), decoded.missingAssets)
    assertTrue(decoded.success)
  }
}
