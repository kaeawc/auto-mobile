package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Device media items (#14192): the `{data}` image binding, the `media:` prefix and the gate. */
class PrototypeMediaItemsTest {
  private val json = Json

  private fun decode(text: String) = json.decodeFromString(PrototypeModeValueSerializer, text)

  @Test
  fun `a data binding decodes round trips and names no uploaded asset`() {
    val bound = decode("""{"data":"/photo"}""")
    assertEquals(PrototypeModeValue.Data("/photo"), bound)
    assertEquals(emptyList(), bound.values)
    assertEquals("""{"data":"/photo"}""", json.encodeToString(PrototypeModeValueSerializer, bound))
    assertEquals(PrototypeModeValue.Modes("a", "b"), decode("""{"light":"a","dark":"b"}"""))
  }

  @Test
  fun `a data binding costs no image budget`() {
    assertEquals(0, prototypeImageSlotUses(buildJsonObject { put("data", "/photo") }))
    assertEquals(1, prototypeImageSlotUses(JsonPrimitive("uploaded")))
    assertEquals(
      2,
      prototypeImageSlotUses(
        buildJsonObject {
          put("light", "a")
          put("dark", "b")
        },
      ),
    )
  }

  @Test
  fun `host asset ids cannot use the reserved prefix`() {
    assertTrue(PrototypeAssetContract.isMediaId("media:5b1f"))
    assertFalse(PrototypeAssetContract.isMediaId("uploaded"))
    assertFalse(PrototypeAssetContract.isMediaId("my-media:x"))
  }

  @Test
  fun `the gate covers image assets and tab items`() {
    fun node(vararg fields: Pair<String, kotlinx.serialization.json.JsonElement>) =
      JsonObject(mapOf(*fields))
    val data = buildJsonObject { put("data", "/photo") }
    assertTrue(
      PrototypeMediaItemBindings.usedBy(node("type" to JsonPrimitive("image"), "asset" to data)),
    )
    assertFalse(
      PrototypeMediaItemBindings.usedBy(
        node("type" to JsonPrimitive("image"), "asset" to JsonPrimitive("uploaded")),
      ),
    )
    assertTrue(
      PrototypeMediaItemBindings.usedBy(
        node(
          "type" to JsonPrimitive("tabBar"),
          "items" to buildJsonArray { add(buildJsonObject { put("image", data) }) },
        ),
      ),
    )
  }
}
