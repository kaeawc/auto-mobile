package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray

/** The Kotlin twin of `restorePrototypeStorage` (#12522): same precedence, same drop reasons. */
class PrototypeStorageRestorerTest {
  private fun spec(storage: String? = STORAGE, data: String = DATA): PrototypeSpec {
    val storageField = storage?.let { ""","storage":$it""" }.orEmpty()
    val input =
      """{"id":"prefs","window":{"placement":{"type":"fullscreen"}},""" +
        """"state":{"dark":false,"count":1,"name":"a"},"data":$data$storageField,""" +
        """"root":{"type":"text","text":"x"}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun stored(version: Int = 1, vararg values: Pair<String, JsonElement>) =
    PrototypeStoredValues(version, linkedMapOf(*values))

  private fun json(text: String) = Json.parseToJsonElement(text)

  @Test
  fun `the storage block decodes into the typed spec and round-trips`() {
    val decoded = spec()
    assertEquals(
      PrototypeStorageBlock(1, listOf("state:dark", "state:count", "data:/cart")),
      decoded.storage,
    )
    assertEquals(
      decoded,
      Json.decodeFromString<PrototypeSpec>(
        Json.encodeToString(PrototypeSpec.serializer(), decoded),
      ),
    )
    assertNull(spec(storage = null).storage)
  }

  @Test
  fun `stored values replace the spec's values for listed keys`() {
    val restore =
      PrototypeStorageRestorer.restore(
        spec(),
        stored(
          1,
          "state:dark" to JsonPrimitive(true),
          "state:count" to JsonPrimitive(7),
          "data:/cart" to json("""{"items":["latte"]}"""),
        ),
      )
    assertEquals(
      mapOf(
        "dark" to PrototypeScalar.BooleanValue(true),
        "count" to PrototypeScalar.Numeric(7.0),
        "name" to PrototypeScalar.Text("a"),
      ),
      restore.spec.state,
    )
    assertEquals(json("""{"items":["latte"]}"""), restore.spec.data!!["cart"])
    assertEquals(JsonPrimitive("T"), restore.spec.data["title"])
    assertEquals(listOf("state:dark", "state:count", "data:/cart"), restore.applied)
    assertEquals(emptyList(), restore.dropped)
  }

  @Test
  fun `nothing stored leaves the spec untouched`() {
    val original = spec()
    val restore = PrototypeStorageRestorer.restore(original, null)
    assertEquals(original, restore.spec)
    assertEquals(emptyList(), restore.applied)
  }

  @Test
  fun `a version mismatch discards every stored value`() {
    val original = spec()
    val restore =
      PrototypeStorageRestorer.restore(
        original,
        stored(2, "state:dark" to JsonPrimitive(true), "data:/cart" to json("{}")),
      )
    assertEquals(original, restore.spec)
    assertEquals(
      listOf(
        PrototypeStorageDrop("state:dark", PrototypeStorageDropReason.VERSION),
        PrototypeStorageDrop("data:/cart", PrototypeStorageDropReason.VERSION),
      ),
      restore.dropped,
    )
  }

  @Test
  fun `unlisted keys are dropped and a spec without storage drops them all`() {
    val values = stored(1, "state:name" to JsonPrimitive("b"), "state:dark" to JsonPrimitive(true))
    val listedOnly = PrototypeStorageRestorer.restore(spec(), values)
    assertEquals(listOf("state:dark"), listedOnly.applied)
    assertEquals(
      listOf(PrototypeStorageDrop("state:name", PrototypeStorageDropReason.UNLISTED)),
      listedOnly.dropped,
    )
    val original = spec(storage = null)
    val none = PrototypeStorageRestorer.restore(original, values)
    assertEquals(original, none.spec)
    assertEquals(setOf(PrototypeStorageDropReason.UNLISTED), none.dropped.map { it.reason }.toSet())
    assertEquals(2, none.dropped.size)
  }

  @Test
  fun `values that no longer fit fall back to the spec's and are dropped`() {
    val original = spec()
    val restore =
      PrototypeStorageRestorer.restore(
        original,
        stored(
          1,
          "state:dark" to JsonPrimitive("yes"), // type changed
          "state:count" to JsonPrimitive("7"), // a string is not a number
          "state:gone" to JsonPrimitive(1), // not declared
          "data:/cart" to buildJsonArray {}, // the spec's cart is an object
        ),
      )
    assertEquals(original.state, restore.spec.state)
    assertEquals(original.data, restore.spec.data)
    assertEquals(emptyList(), restore.applied)
    assertEquals(4, restore.dropped.size)
    assertEquals(
      setOf(PrototypeStorageDropReason.MISMATCH, PrototypeStorageDropReason.UNLISTED),
      restore.dropped.map { it.reason }.toSet(),
    )
  }

  @Test
  fun `a data write the writer refuses is dropped`() {
    val withMissingParent = spec(storage = """{"version":1,"keys":["data:/missing/child"]}""")
    val restore =
      PrototypeStorageRestorer.restore(
        withMissingParent,
        stored(1, "data:/missing/child" to JsonPrimitive(1)),
      )
    assertEquals(withMissingParent, restore.spec)
    assertEquals(
      listOf(PrototypeStorageDrop("data:/missing/child", PrototypeStorageDropReason.MISMATCH)),
      restore.dropped,
    )
  }

  @Test
  fun `a data value of another json kind is dropped but a new member is created`() {
    val block = spec(storage = """{"version":1,"keys":["data:/title","data:/extra"]}""")
    val restore =
      PrototypeStorageRestorer.restore(
        block,
        stored(1, "data:/title" to JsonPrimitive(3), "data:/extra" to JsonPrimitive("kept")),
      )
    assertEquals(JsonPrimitive("T"), restore.spec.data!!["title"])
    assertEquals(JsonPrimitive("kept"), restore.spec.data["extra"])
    assertEquals(listOf("data:/extra"), restore.applied)
    assertEquals(
      listOf(PrototypeStorageDrop("data:/title", PrototypeStorageDropReason.MISMATCH)),
      restore.dropped,
    )
  }

  @Test
  fun `keys parse like the host's and entries are counted in utf8 bytes`() {
    assertEquals(PrototypeStorageKey.State("dark"), PrototypeStorageKey.parse("state:dark"))
    assertEquals(
      PrototypeStorageKey.Data("/cart/items"),
      PrototypeStorageKey.parse("data:/cart/items"),
    )
    assertNull(PrototypeStorageKey.parse("state:1bad"))
    assertNull(PrototypeStorageKey.parse("data:"))
    assertNull(PrototypeStorageKey.parse("data:cart"))
    assertNull(PrototypeStorageKey.parse("other:x"))
    // "state:name" is 10 bytes; "é" is two bytes, so the JSON string "é" is 4.
    assertEquals(14, PrototypeStorageRestorer.entryBytes("state:name", JsonPrimitive("é")))
    assertEquals(
      mapOf("state:dark" to JsonPrimitive(false), "state:count" to JsonPrimitive(1)),
      PrototypeStorageRestorer.currentValues(
        spec(storage = """{"version":1,"keys":["state:dark","state:count","data:/nope"]}"""),
      ),
    )
  }

  private companion object {
    const val STORAGE = """{"version":1,"keys":["state:dark","state:count","data:/cart"]}"""
    const val DATA = """{"cart":{"items":[]},"title":"T"}"""
  }
}
