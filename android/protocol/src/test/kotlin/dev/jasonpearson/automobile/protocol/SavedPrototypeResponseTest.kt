package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test

class SavedPrototypeResponseTest {
  private val json = Json { encodeDefaults = true }

  @Test
  fun `pin status and shortcut update serialize snake case`() {
    for (status in SavedPrototypePinStatus.entries) {
      val result = PrototypeResult(42, "pin", true, pin = SavedPrototypePinInfo("panel", status))
      val literal = json.encodeToString<WebSocketResponse>(result)
      assertEquals(
        status.name.lowercase(),
        Json.parseToJsonElement(literal)
          .jsonObject
          .getValue("pin")
          .jsonObject
          .getValue("status")
          .jsonPrimitive
          .content,
      )
      assertEquals(result, json.decodeFromString<WebSocketResponse>(literal))
    }
    for (update in SavedPrototypeShortcutUpdate.entries) {
      val saved = SavedPrototypeInfo("panel", "slug", true, update)
      assertEquals(
        update.name.lowercase(),
        Json.parseToJsonElement(json.encodeToString(saved))
          .jsonObject
          .getValue("shortcut")
          .jsonPrimitive
          .content,
      )
    }
    assertFalse(
      "shortcut" in
        Json.parseToJsonElement(json.encodeToString(SavedPrototypeInfo("panel", "slug", false)))
          .jsonObject,
    )
  }

  @Test
  fun `legacy prototype result remains byte identical with null saved fields`() {
    assertEquals(
      """{"type":"prototype_result","timestamp":42,"requestId":"r","success":true,"error":null}""",
      json.encodeToString<WebSocketResponse>(PrototypeResult(42, "r", true)),
    )
    val literal =
      json.encodeToString<WebSocketResponse>(
        PrototypeResult(42, "r", false, error = "failure", missingAssets = listOf("hero")),
      )
    assertEquals(
      """{"type":"prototype_result","timestamp":42,"requestId":"r","success":false,"error":"failure","missingAssets":["hero"]}""",
      literal,
    )
  }

  @Test
  fun `saved info encodes replacement and round trips`() {
    val result =
      PrototypeResult(42, "r", true, saved = SavedPrototypeInfo("panel", "panel-slug", true))
    val literal = json.encodeToString<WebSocketResponse>(result)
    assertEquals(
      Json.parseToJsonElement("""{"id":"panel","slug":"panel-slug","replaced":true}"""),
      Json.parseToJsonElement(literal).jsonObject["saved"],
    )
    assertEquals(result, json.decodeFromString<WebSocketResponse>(literal))
    assertFalse("savedPrototypes" in Json.parseToJsonElement(literal).jsonObject)
    assertFalse("errorCode" in Json.parseToJsonElement(literal).jsonObject)
  }

  @Test
  fun `saved list encodes time and pinned flags including empty list`() {
    for (entries in
      listOf(emptyList(), listOf(SavedPrototypeEntry("panel", "Panel", "slug", 42L, true)))) {
      val result = PrototypeResult(42, "r", true, savedPrototypes = entries)
      val literal = json.encodeToString<WebSocketResponse>(result)
      assertEquals(
        json.encodeToString(entries),
        Json.parseToJsonElement(literal).jsonObject.getValue("savedPrototypes").toString(),
      )
      assertEquals(result, json.decodeFromString<WebSocketResponse>(literal))
    }
  }

  @Test
  fun `all typed refusal codes encode lower snake case and round trip`() {
    for (code in enumValues<SavedPrototypeErrorCode>()) {
      val result = PrototypeResult(42, "r", false, "refused", errorCode = code)
      val literal = json.encodeToString<WebSocketResponse>(result)
      assertEquals(
        code.name.lowercase(),
        Json.parseToJsonElement(literal).jsonObject.getValue("errorCode").jsonPrimitive.content,
      )
      assertEquals(result, json.decodeFromString<WebSocketResponse>(literal))
    }
  }
}
