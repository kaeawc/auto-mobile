package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeDataLimitsTest : PrototypeDataTestSupport() {
  @Test
  fun `data limits are loaded from the shared contract`() {
    val limits =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json"))
            .bufferedReader()
            .use { it.readText() },
        )
        .jsonObject
        .getValue("limits")
        .jsonObject
    val actual =
      mapOf(
        "MAX_PROTOTYPE_REPEAT_PATH_CELLS" to PrototypeSpecValidator.MAX_PROTOTYPE_REPEAT_PATH_CELLS,
        "MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH" to
          PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH,
        "MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL" to
          PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL,
        "MAX_PROTOTYPE_DATA_BYTES" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_BYTES,
        "MAX_PROTOTYPE_DATA_DEPTH" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_DEPTH,
        "MAX_PROTOTYPE_DATA_ARRAY_ITEMS" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
        "MAX_PROTOTYPE_DATA_POINTER_LENGTH" to
          PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
      )
    for ((name, value) in actual) assertEquals(limits.getValue(name).jsonPrimitive.int, value)
  }

  @Test
  fun `shared repeat cell boundary fixtures have matching errors`() {
    val result = PrototypeSpecValidator.validate(cellInvalid.getValue("spec").toString())
    assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
    val error = (result as PrototypeSpecValidation.Failure).error
    assertEquals(cellInvalid.getValue("expectedPath").jsonPrimitive.content, error.path)
    assertEquals(cellInvalid.getValue("expectedMessage").jsonPrimitive.content, error.message)
    assertTrue(
      PrototypeSpecValidator.validate(cellExact.toString()) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `three path source errors win before cell errors`() {
    val source = cellInvalid.getValue("spec").jsonObject
    val data = source.getValue("data").jsonObject
    val objects = data.getValue("items").jsonArray
    val invalidSources =
      listOf(
        JsonObject(emptyMap()) to "Repeat path does not resolve to an array",
        JsonArray(objects + objects.first()) to "Repeat path resolves to more than 128 items",
        JsonArray(objects.dropLast(1) + JsonPrimitive(true)) to
          "Repeat path item 127 is not an object",
      )
    val root = source.getValue("root").jsonObject
    val children = root.getValue("children").jsonArray
    val last = children.last().jsonObject
    val repeat = last.getValue("repeat").jsonObject
    val badRepeat = JsonObject(repeat + ("items" to buildJsonObject { put("path", "/bad") }))
    val bad = JsonObject(last + ("repeat" to badRepeat))
    for ((items, message) in invalidSources) {
      val value =
        JsonObject(
          source +
            mapOf(
              "data" to JsonObject(data + ("bad" to items)),
              "root" to JsonObject(root + ("children" to JsonArray(children.dropLast(1) + bad))),
            ),
        )
      val error = PrototypeRepeatValidator.validate(value)
      assertEquals("root.children[19].repeat.items.path", error?.path)
      assertEquals(message, error?.message)
    }
  }

  @Test
  fun `literal repeats do not count and empty projections count one cell`() {
    val source = cellInvalid.getValue("spec").jsonObject
    val items = source.getValue("data").jsonObject.getValue("items")
    val children =
      source.getValue("root").jsonObject.getValue("children").jsonArray.map {
        val node = it.jsonObject
        val repeat = JsonObject(node.getValue("repeat").jsonObject + ("items" to items))
        JsonObject(node + ("repeat" to repeat))
      }
    val literal = buildJsonObject {
      put(
        "root",
        buildJsonObject {
          put("type", "column")
          put("children", JsonArray(children))
        },
      )
    }
    assertNull(PrototypeRepeatValidator.validate(literal))
    val data =
      Json.parseToJsonElement("""{"items":[{"bad name":true,"nested":{}},{}]}""").jsonObject
    val cache = PrototypeRepeatData(data)
    assertEquals(2, cache.cells("/items"))
    assertEquals(listOf(JsonObject(emptyMap()), JsonObject(emptyMap())), cache.items("/items"))
  }

  @Test
  fun `1500 repeats reject the crossing container and reuse the projected list`() {
    val cache = PrototypeRepeatData(amplified.getValue("data").jsonObject)
    val error = PrototypeRepeatValidator.validate(amplified, cache)
    assertEquals("root.children[2].repeat.items.path", error?.path)
    assertEquals("Repeat path cell limit exceeded", error?.message)
    val scopes = PrototypeRepeatValidator.scopes(amplified, cache)
    assertEquals(1500, scopes.size)
    assertTrue(scopes.all { it.items === scopes.first().items })
    assertSame(scopes.first().items, cache.items("/items"))
    assertEquals(25600, cache.cells("/items"))
  }

  @Test
  fun `resolveRoot shares projected arrays per pointer and isolates separate calls`() {
    val source = cellExact
    val root = source.getValue("root").jsonObject
    val data = source.getValue("data").jsonObject
    val resolved = PrototypeDataResolver.resolveRoot(root, data)
    fun arrays(value: JsonObject) =
      value.getValue("children").jsonArray.map {
        it.jsonObject.getValue("repeat").jsonObject.getValue("items")
      }
    val projected = arrays(resolved)
    assertTrue(projected.all { it === projected.first() })
    assertNotSame(projected.first(), arrays(PrototypeDataResolver.resolveRoot(root, data)).first())
    assertEquals(root, source["root"])
  }

  @Test
  fun `data amplification is rejected without building the replacement`() {
    val input =
      substitutionSpec(
        substitutionText("{data:/b}".repeat(80_000)),
        data = buildJsonObject { put("b", "x".repeat(200_000)) },
      )
    assertSubstitutionError(input, "root.text")
  }

  @Test
  fun `data substitution boundary`() {
    for (length in listOf(16_384, 16_385)) {
      val input =
        substitutionSpec(
          substitutionText("{data:/b}"),
          data = buildJsonObject { put("b", "x".repeat(length)) },
        )
      if (length == 16_384) assertSubstitutionValid(input)
      else assertSubstitutionError(input, "root.text")
    }
  }

  @Test
  fun `repeat text emit and operand are capped`() {
    val replacement = "{item.b}{item.b}"
    val cases =
      listOf(
        substitutionText(replacement) to "text",
        substitutionAction("emit", "name", replacement) to "onTap[0].name",
        substitutionAction("setState", "value", replacement) to "onTap[0].value",
      )
    for ((child, field) in cases) {
      val input =
        substitutionSpec(
          substitutionList(child, listOf("x".repeat(8193))),
          state = buildJsonObject { put("k", "") },
        )
      assertSubstitutionError(input, "root.children[0].$field")
    }
  }

  @Test
  fun `repeat key amplification uses the fixed error before binding`() {
    val child = substitutionAction("toggle", "key", "{item.b}".repeat(2000))
    assertSubstitutionError(
      substitutionSpec(substitutionList(child, listOf("x".repeat(100_000)))),
      "root.children[0].onTap[0].key",
    )
  }

  @Test
  fun `repeat counts index and each item's own rendered length`() {
    val indices = substitutionList(substitutionText("{index}".repeat(8193)), List(11) { "" })
    assertSubstitutionError(substitutionSpec(indices), "root.children[0].text")
    val items =
      substitutionList(substitutionText("{item.b}{item.b}"), listOf("s", "x".repeat(8193)))
    assertSubstitutionError(substitutionSpec(items), "root.children[0].text")
  }

  @Test
  fun `data cascades into repeat and path items use the same bound`() {
    val root = substitutionList(substitutionText("{data:/t}"), listOf("x".repeat(8193)))
    assertSubstitutionError(
      substitutionSpec(root, data = buildJsonObject { put("t", "{item.b}{item.b}") }),
      "root.children[0].text",
    )
    val pathRoot =
      JsonObject(
        root +
          mapOf(
            "repeat" to
              buildJsonObject {
                put("items", buildJsonObject { put("path", "/rows") })
                put("as", "item")
              },
            "children" to JsonArray(listOf(substitutionText("{item.b}{item.b}"))),
          ),
      )
    val data = buildJsonObject {
      put("rows", JsonArray(listOf(buildJsonObject { put("b", "x".repeat(8193)) })))
    }
    assertSubstitutionError(substitutionSpec(pathRoot, data = data), "root.children[0].text")
  }

  @Test
  fun `literal characters and mutable state replacements do not count`() {
    val inputs =
      listOf(
        substitutionSpec(substitutionText("x".repeat(20_000))),
        substitutionSpec(
          substitutionText("x".repeat(20_000) + "{data:/s}"),
          data = buildJsonObject { put("s", "short") },
        ),
        substitutionSpec(
          substitutionText("{b}".repeat(1000)),
          state = buildJsonObject { put("b", "x".repeat(100_000)) },
        ),
      )
    inputs.forEach(::assertSubstitutionValid)
  }

  @Test
  fun `unknown authored repeat fields win before the length error`() {
    val input =
      substitutionSpec(
        substitutionList(substitutionText("{item.missing}{data:/b}"), listOf("")),
        data = buildJsonObject { put("b", "x".repeat(16_385)) },
      )
    val result = PrototypeSpecValidator.validate(input.toString())
    assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
    assertEquals(
      PrototypeSpecError("root.children[0].text", "Unknown repeat field \"missing\""),
      (result as PrototypeSpecValidation.Failure).error,
    )
  }
}
