package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

/**
 * The Kotlin twin of the `applyPrototypeDataWrite` and data action validation cases in
 * `test/features/prototype/prototypeDataActions.test.ts` (#12519): same semantics, same codes.
 */
class PrototypeDataWriteTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

  private val data =
    obj("""{"cart":[{"sku":"a"},{"sku":"b"}],"profile":{"name":"Ada"},"deep":{"list":[{"n":1}]}}""")

  private fun set(path: String, value: Any = 1) = PrototypeDataWrite.Set(path, element(value))

  private fun append(path: String, value: Any = 1) = PrototypeDataWrite.Append(path, element(value))

  private fun remove(path: String) = PrototypeDataWrite.Remove(path)

  private fun element(value: Any) =
    when (value) {
      is String -> JsonPrimitive(value)
      is Number -> JsonPrimitive(value)
      else -> Json.parseToJsonElement(value.toString())
    }

  private fun ok(write: PrototypeDataWrite, from: JsonObject? = data): JsonObject =
    when (val result = PrototypeDataWriter.apply(from, write)) {
      is PrototypeDataWriteResult.Success -> result.data
      is PrototypeDataWriteResult.Failure -> error(result.error.toString())
    }

  private fun code(write: PrototypeDataWrite, from: JsonObject? = data): String? =
    (PrototypeDataWriter.apply(from, write) as? PrototypeDataWriteResult.Failure)
      ?.error
      ?.code
      ?.wireValue

  @Test
  fun `set creates or replaces an object member and replaces an array element`() {
    assertEquals(
      obj(
        """{"cart":[{"sku":"a"},{"sku":"b"}],"profile":{"name":"Ada","age":3},"deep":{"list":[{"n":1}]}}""",
      ),
      ok(set("/data/profile/age", 3)),
    )
    assertEquals(
      JsonPrimitive("G"),
      ok(set("/data/profile/name", "G"))["profile"]?.jsonObject?.get("name"),
    )
    assertEquals(
      obj("""{"cart":[{"sku":"a"},"x"]}""")["cart"],
      ok(set("/data/cart/1", "x"))["cart"],
    )
    assertEquals(obj("""{"a":1}"""), ok(set("/data/a"), from = null))
  }

  @Test
  fun `set reaches a nested pointer through objects and arrays and keeps its siblings`() {
    val written = ok(set("/data/deep/list/0/n", 9))
    assertEquals(obj("""{"list":[{"n":9}]}"""), written["deep"])
    assertEquals(data["cart"], written["cart"])
    assertEquals(data["profile"], written["profile"])
  }

  @Test
  fun `escaped pointer tokens address members with slashes and tildes`() {
    val written = ok(set("/data/a~1b/c~0d"), from = obj("""{"a/b":{}}"""))
    assertEquals(obj("""{"a/b":{"c~d":1}}"""), written)
  }

  @Test
  fun `append pushes onto an existing array`() {
    assertEquals(
      obj("""[{"sku":"a"},{"sku":"b"},{"sku":"c"}]""".let { """{"x":$it}""" })["x"],
      ok(append("/data/cart", obj("""{"sku":"c"}""")))["cart"],
    )
    assertEquals(
      obj("""{"x":[{"n":1},2]}""")["x"],
      ok(append("/data/deep/list", 2))["deep"]?.jsonObject?.get("list"),
    )
  }

  @Test
  fun `remove deletes a member or shifts later elements down`() {
    assertEquals(obj("""{"x":[{"sku":"b"}]}""")["x"], ok(remove("/data/cart/0"))["cart"])
    assertEquals(obj("""{}"""), ok(remove("/data/profile/name"))["profile"])
  }

  @Test
  fun `a write never mutates its input and shares untouched branches`() {
    val before = Json.parseToJsonElement(data.toString()).jsonObject
    val written = ok(append("/data/cart"))
    ok(remove("/data/cart/0"))
    assertEquals(before, data)
    assertNotSame(data["cart"], written["cart"])
    assertEquals(data["profile"], written["profile"])
  }

  @Test
  fun `typed errors`() {
    val cases =
      listOf(
        set("/data") to "invalid_path",
        set("/state/a") to "invalid_path",
        remove("/data/a~2") to "invalid_path",
        set("/data/missing/child") to "not_found",
        set("/data/cart/5") to "not_found",
        set("/data/cart/name") to "not_found",
        set("/data/profile/name/deep") to "not_found",
        append("/data/missing") to "not_found",
        append("/data/profile") to "not_array",
        append("/data/profile/name") to "not_array",
        remove("/data/missing") to "not_found",
        remove("/data/cart/2") to "not_found",
        PrototypeDataWrite.Set("/data/a", kotlinx.serialization.json.JsonNull) to "invalid_value",
        PrototypeDataWrite.Append("/data/cart", obj("""{"n":null}""")) to "invalid_value",
      )
    for ((write, expected) in cases) assertEquals(expected, code(write), write.toString())
  }

  @Test
  fun `a write that leaves data over the size limit changes nothing`() {
    val limit = PrototypeSpecValidator.MAX_PROTOTYPE_DATA_WRITE_BYTES
    val nearly = buildJsonObject { put("big", "x".repeat(limit - 64)) }
    assertEquals(null, code(set("/data/small", "y"), nearly))
    assertEquals("limit_exceeded", code(set("/data/more", "y".repeat(256)), nearly))
  }

  @Test
  fun `a write that leaves data over the array or depth limit is refused`() {
    val full = buildJsonObject {
      put("rows", JsonArrayOf(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS))
    }
    assertEquals("limit_exceeded", code(append("/data/rows"), full))
    val deep = obj("""{"a":{"b":{"c":{"d":{"e":{"f":{}}}}}}}""")
    assertEquals(
      "limit_exceeded",
      code(PrototypeDataWrite.Set("/data/a/b/c/d/e/f/g", obj("""{"h":{"i":1}}""")), deep),
    )
  }

  @Test
  fun `a __proto__ member is data, not a prototype`() {
    val written = ok(set("/data/__proto__", obj("""{"x":1}""")), from = JsonObject(emptyMap()))
    assertTrue(written.containsKey("__proto__"))
  }

  @Test
  fun `values resolve from a literal, state or data and a missing source is a typed error`() {
    val inputs =
      object : EmitContextInputs {
        override fun state(key: String) = if (key == "picked") JsonPrimitive("apple") else null

        override fun page(id: String): Int? = null

        override fun data(pointer: String) = PrototypeDataPointer.resolve(data, pointer)
      }
    fun resolve(binding: String) = PrototypeDataWriter.resolveValue(obj(binding), inputs)
    assertEquals(
      PrototypeDataValue.Resolved(JsonPrimitive("apple")),
      resolve("""{"state":"picked"}"""),
    )
    assertEquals(
      PrototypeDataValue.Resolved(JsonPrimitive("Ada")),
      resolve("""{"data":"/profile/name"}"""),
    )
    assertEquals(PrototypeDataValue.Resolved(JsonPrimitive(1)), resolve("""{"value":1}"""))
    assertEquals(
      PrototypeDataWriteErrorCode.INVALID_VALUE,
      (resolve("""{"state":"nope"}""") as PrototypeDataValue.Failure).error.code,
    )
    assertEquals(
      PrototypeDataWriteErrorCode.NOT_FOUND,
      (resolve("""{"data":"/nope"}""") as PrototypeDataValue.Failure).error.code,
    )
  }

  private fun JsonArrayOf(size: Int) =
    kotlinx.serialization.json.JsonArray(List(size) { JsonPrimitive(1) })

  // --- validation of the actions in a spec ---

  private fun specWith(actions: String, data: String = """{"cart":[],"profile":{"name":"Ada"}}""") =
    """{"id":"shop","window":{"placement":{"type":"fullscreen"}},"state":{"picked":"apple"},
      "root":{"type":"text","text":"Hello","onTap":$actions},"data":$data}"""

  private fun rejection(spec: String): PrototypeSpecError =
    (PrototypeSpecValidator.validate(spec) as PrototypeSpecValidation.Failure).error

  private fun action(type: String, path: String, value: String = """{"value":1}""") =
    if (type == "removeData") """{"type":"removeData","path":"$path"}"""
    else """{"type":"$type","path":"$path","value":$value}"""

  @Test
  fun `a valid set of data actions validates and decodes`() {
    val spec =
      specWith(
        "[" +
          listOf(
              action("setData", "/data/profile/name", """{"value":"Grace"}"""),
              action("setData", "/data/profile/title", """{"state":"picked"}"""),
              action("appendData", "/data/cart", """{"value":{"sku":"x","qty":1}}"""),
              action("removeData", "/data/cart/0"),
            )
            .joinToString(",") +
          "]",
      )
    val parsed = (PrototypeSpecValidator.validate(spec) as PrototypeSpecValidation.Success).spec
    val actions = (parsed.root as PrototypeTextNode).onTap.orEmpty()
    assertEquals(
      listOf(
        PrototypeSetDataAction("/data/profile/name", obj("""{"value":"Grace"}""")),
        PrototypeSetDataAction("/data/profile/title", obj("""{"state":"picked"}""")),
        PrototypeAppendDataAction("/data/cart", obj("""{"value":{"sku":"x","qty":1}}""")),
        PrototypeRemoveDataAction("/data/cart/0"),
      ),
      actions,
    )
  }

  @Test
  fun `pointers outside data are rejected at the action path`() {
    for (path in
      listOf(
        "/data",
        "/state/picked",
        "/dat/a",
        "data/a",
        "/data/a~2",
        "/data/a~",
        "/data/${"a".repeat(260)}",
      )) {
      for (type in listOf("setData", "appendData", "removeData")) {
        assertEquals(
          "root.onTap[0].path",
          rejection(specWith("[${action(type, path)}]")).path,
          "$type $path",
        )
      }
    }
  }

  @Test
  fun `escaped pointer tokens validate`() {
    assertTrue(
      PrototypeSpecValidator.validate(specWith("[${action("setData", "/data/a~1b/c~0d")}]"))
        is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `appendData on a statically non-array target is refused and an unknown target is left to the device`() {
    for (path in listOf("/data/profile", "/data/profile/name")) {
      val error = rejection(specWith("[${action("appendData", path)}]"))
      assertEquals("root.onTap[0].path", error.path)
      assertEquals("appendData target is not an array", error.message)
    }
    for (path in listOf("/data/cart", "/data/later")) {
      assertTrue(
        PrototypeSpecValidator.validate(specWith("[${action("appendData", path)}]"))
          is PrototypeSpecValidation.Success,
      )
    }
  }

  @Test
  fun `a literal value must be data`() {
    for (value in listOf("null", """{"nested":null}""", "[null]")) {
      val error = rejection(specWith("[${action("setData", "/data/a", """{"value":$value}""")}]"))
      assertEquals("root.onTap[0].value.value", error.path)
    }
  }

  @Test
  fun `index outside a repeat and item outside a repeat are refused`() {
    val index = rejection(specWith("[${action("removeData", "/data/cart/{index}")}]"))
    assertEquals("root.onTap[0].path", index.path)
    assertEquals("{index} outside a repeat template", index.message)
    val item = rejection(specWith("[${action("setData", "/data/a", """{"item":"id"}""")}]"))
    assertTrue(item.path.startsWith("root.onTap[0]"))
  }

  private fun repeatSpec(actions: String) =
    """{"id":"shop","window":{"placement":{"type":"fullscreen"}},
      "root":{"type":"column","children":[{"type":"row","id":"row",
        "repeat":{"items":[{"id":"a"},{"id":"b"}],"as":"item"},
        "children":[{"type":"text","id":"label","text":"Hello","onTap":$actions}]}]}}"""

  @Test
  fun `a repeat row binds index as a whole path segment`() {
    val actions =
      "[" +
        listOf(
            action("removeData", "/data/cart/{index}"),
            action("setData", "/data/names/{index}", """{"item":"id"}"""),
            action("setData", "/data/at/{index}", """{"index":true}"""),
          )
          .joinToString(",") +
        "]"
    assertTrue(
      PrototypeSpecValidator.validate(repeatSpec(actions)) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `inside a repeat a partial index or an item field in the path is refused`() {
    mapOf(
        "/data/cart/row{index}" to "{index} must be a whole data path segment",
        "/data/cart/{item.id}" to
          "Only a whole {index} segment may be a placeholder in a data path",
      )
      .forEach { (path, message) ->
        assertEquals(message, rejection(repeatSpec("[${action("removeData", path)}]")).message)
      }
  }
}
