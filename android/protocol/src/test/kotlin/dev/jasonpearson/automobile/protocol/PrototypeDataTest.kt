package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeDataTest {
  @TestFactory
  fun pointers(): List<DynamicTest> =
    pointerFixture.getValue("cases").jsonArray.map { entry ->
      val case = entry.jsonObject
      val pointer = case.getValue("pointer").jsonPrimitive.content
      DynamicTest.dynamicTest("pointer $pointer") {
        assertEquals(
          case.getValue("valid").jsonPrimitive.boolean,
          PrototypeDataPointer.isValid(pointer),
        )
        val result =
          PrototypeDataPointer.resolve(pointerFixture.getValue("data").jsonObject, pointer)
        assertEquals(case.getValue("found").jsonPrimitive.boolean, result != null)
        if (case.containsKey("value")) assertEquals(case["value"], result)
      }
    }

  @TestFactory
  fun resolvedFixtures(): List<DynamicTest> = fixtures.map { (file, fixture) ->
    DynamicTest.dynamicTest("resolve ${file.name}") {
      val source = fixture.getValue("spec").jsonObject
      val result = PrototypeSpecValidator.validate(source.toString())
      assertTrue(result is PrototypeSpecValidation.Success, result.toString())
      val spec = (result as PrototypeSpecValidation.Success).spec
      val expected = fixture.getValue("root")
      assertEquals(
        expected,
        PrototypeDataResolver.resolveRoot(source.getValue("root").jsonObject, spec.data),
      )
      val resolved = PrototypeDataResolver.resolve(spec)
      assertEquals(expected, json.encodeToJsonElement(PrototypeNode.serializer(), resolved.root))
      assertSame(spec.data, resolved.data)
      assertSame(spec.state, resolved.state)
      assertSame(spec.window, resolved.window)
      assertSame(spec.theme, resolved.theme)
      assertEquals(spec.motion, resolved.motion)
      assertEquals(spec.id, resolved.id)
      assertEquals(
        source["data"],
        json.encodeToJsonElement(PrototypeSpec.serializer(), resolved).jsonObject["data"],
      )
    }
  }

  @Test
  fun `unbound specs retain their identity with or without data`() {
    val source =
      fixtures.entries.single { it.key.name == "no-bindings.json" }.value.getValue("spec")
    val spec =
      (PrototypeSpecValidator.validate(source.toString()) as PrototypeSpecValidation.Success).spec
    assertSame(spec, PrototypeDataResolver.resolve(spec))
    val withoutData = spec.copy(data = null)
    assertSame(withoutData, PrototypeDataResolver.resolve(withoutData))
    val literal =
      fixtures.entries
        .single { it.key.name == "literal-repeat-untouched.json" }
        .value
        .getValue("spec")
    val literalSpec =
      (PrototypeSpecValidator.validate(literal.toString()) as PrototypeSpecValidation.Success).spec
    assertSame(literalSpec, PrototypeDataResolver.resolve(literalSpec))
  }

  @Test
  fun `path repeat wire format never exposes itemsPath`() {
    val input = Json.parseToJsonElement("""{"items":{"path":"/orders"},"as":"order","key":"id"}""")
    val decoded = json.decodeFromJsonElement<PrototypeRepeat>(input)
    assertEquals("/orders", decoded.itemsPath)
    assertTrue(decoded.items.isEmpty())
    val encoded = json.encodeToJsonElement(PrototypeRepeat.serializer(), decoded)
    assertEquals(input, encoded)
    assertFalse(encoded.jsonObject.containsKey("itemsPath"))
    val literal = Json.parseToJsonElement("""{"items":[{"id":"one"}],"as":"item","key":"id"}""")
    assertEquals(
      literal,
      json.encodeToJsonElement(json.decodeFromJsonElement<PrototypeRepeat>(literal)),
    )
  }

  @Test
  fun `status data is omitted even when defaults are encoded and otherwise round trips`() {
    val encoder = Json { encodeDefaults = true }
    val entry = PrototypeStatusEntry("shown", false, emptyMap(), lastSequence = 0)
    assertFalse(
      encoder
        .encodeToJsonElement(PrototypeStatusEntry.serializer(), entry)
        .jsonObject
        .containsKey("data"),
    )
    val data = buildJsonObject { put("count", 7) }
    val withData = entry.copy(data = data)
    val encoded = encoder.encodeToJsonElement(PrototypeStatusEntry.serializer(), withData)
    assertEquals(data, encoded.jsonObject["data"])
    assertEquals(withData, encoder.decodeFromJsonElement<PrototypeStatusEntry>(encoded))
  }

  @TestFactory
  fun conditionSemantics(): List<DynamicTest> = conditionCases.map { case ->
    DynamicTest.dynamicTest("condition ${case.condition}") {
      val root = buildJsonObject {
        put("type", "text")
        put("text", "x")
        put("visibleWhen", case.condition)
      }
      val resolved = PrototypeDataResolver.resolveRoot(root, conditionData)
      val expected = buildJsonObject {
        put(if (case.holds) "all" else "any", JsonArray(emptyList()))
      }
      assertEquals(expected, resolved["visibleWhen"])
    }
  }

  @Test
  fun `pointer parsing is total and counts UTF16 units`() {
    assertEquals(listOf("a~1", "/"), PrototypeDataPointer.tokens("/a~01/~1"))
    assertEquals(emptyList<String>(), PrototypeDataPointer.tokens("bad"))
    assertNull(PrototypeDataPointer.resolve(null, "/x"))
    assertFalse(PrototypeDataPointer.isValid("/" + "😀".repeat(128)))
    assertTrue(PrototypeDataPointer.isValid("/" + "a".repeat(255)))
    val data = Json.parseToJsonElement("""{"a":[1]}""").jsonObject
    for (token in listOf("-1", "1.0", "99999999999999999999999999999999999")) {
      assertNull(PrototypeDataPointer.resolve(data, "/a/$token"))
    }
  }

  @Test
  fun `runtime repeat fallback skips nonobjects and bounds projected instances`() {
    val root =
      Json.parseToJsonElement(
          """{"type":"column","repeat":{"items":{"path":"/a"},"as":"item","key":"id"},"children":[]}""",
        )
        .jsonObject
    for (data in listOf(null, buildJsonObject { put("a", true) })) {
      val repeat = PrototypeDataResolver.resolveRoot(root, data).getValue("repeat").jsonObject
      assertEquals(JsonArray(emptyList()), repeat["items"])
      assertEquals(JsonPrimitive("id"), repeat["key"])
    }
    val maximum = PrototypeSpecValidator.maxRepeatItems
    val items =
      listOf(JsonPrimitive(false)) +
        List(maximum + 1) { index ->
          buildJsonObject {
            put("id", index)
            put("bad name", true)
          }
        }
    val resolved =
      PrototypeDataResolver.resolveRoot(root, buildJsonObject { put("a", JsonArray(items)) })
    val projected = resolved.getValue("repeat").jsonObject.getValue("items").jsonArray
    assertEquals(maximum, projected.size)
    assertEquals(buildJsonObject { put("id", 0) }, projected.first())
    assertEquals(buildJsonObject { put("id", maximum - 1) }, projected.last())
  }

  @Test
  fun `child walk and authored text scanning preserve replacement text`() {
    val root =
      Json.parseToJsonElement(
          """{"type":"scroll","child":{"type":"text","text":"{{data:/s}} {state_key} {item.name} {data:/missing}"}}""",
        )
        .jsonObject
    val data = buildJsonObject { put("s", "{data:/missing}") }
    val resolved = PrototypeDataResolver.resolveRoot(root, data)
    assertEquals(
      "{{data:/missing}} {state_key} {item.name} ",
      resolved.getValue("child").jsonObject.getValue("text").jsonPrimitive.content,
    )
  }

  @Test
  fun `placeholder scan bounds pointer lengths and literal braces`() {
    val key = "a".repeat(255)
    val data = buildJsonObject {
      put(key, "bound")
      put("a", "one")
    }
    assertEquals("bound", PrototypeDataText.bind("{data:/$key}", data))
    val overlong = "{data:/${key}a}"
    assertFalse(PrototypeDataText.hasBinding(overlong))
    assertEquals(overlong, PrototypeDataText.bind(overlong, data))
    assertEquals("{data:/a", PrototypeDataText.bind("{data:/a", data))
    val braces = "{".repeat(50_000)
    assertEquals(braces + "one", PrototypeDataText.bind(braces + "{data:/a}", data))
  }

  @Test
  fun `repeat keys compare nonintegral numbers by value`() {
    for ((items, text) in
      listOf(
        """[{"id":1.5},{"id":1.50}]""" to "1.5",
        """[{"id":0.5},{"id":5e-1}]""" to "0.5",
      )) {
      val input =
        """{"id":"numbers","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","repeat":{"items":$items,"as":"item","key":"id"},"children":[]}}"""
      val result = PrototypeSpecValidator.validate(input)
      assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
      val error = (result as PrototypeSpecValidation.Failure).error
      assertEquals("root.repeat.key", error.path)
      assertEquals("Duplicate repeat key \"$text\" (items 0 and 1)", error.message)
    }
  }

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

  @Test
  fun `condition operands share the exact substituted text total`() {
    val operand = buildJsonObject {
      put("key", "k")
      put("equals", "{item.b}y")
    }
    val condition = buildJsonObject {
      put(
        "all",
        JsonArray(List(16) { buildJsonObject { put("any", JsonArray(List(16) { operand })) } }),
      )
    }
    val child = JsonObject(substitutionText("t") + ("visibleWhen" to condition))
    val root = substitutionList(child, listOf("x".repeat(16375)))
    val state = buildJsonObject { put("k", "") }
    assertSubstitutionValid(substitutionSpec(root, state = state))
    val extra = JsonObject(substitutionText("t") + ("visibleWhen" to operand))
    val crossed = JsonObject(root + ("children" to JsonArray(listOf(child, extra))))
    val unknown = substitutionText("{item.missing}{data:/s}")
    val unknownRoot = JsonObject(root + ("children" to JsonArray(listOf(child, unknown))))
    assertEquals(
      PrototypeSpecError("root.children[1].text", "Unknown repeat field \"missing\""),
      PrototypeRepeatValidator.validate(
        substitutionSpec(unknownRoot, data = buildJsonObject { put("s", "") }, state = state),
      ),
    )
    assertEquals(
      PrototypeSpecError(
        "root.children[1].visibleWhen.equals",
        "Substituted text total limit exceeded",
      ),
      PrototypeRepeatValidator.validate(substitutionSpec(crossed, state = state)),
    )
  }

  @Test
  fun `repeat total charges each item in order`() {
    val root = buildJsonObject {
      put("type", "column")
      put(
        "repeat",
        buildJsonObject {
          put("as", "i")
          put("items", JsonArray(List(4) { buildJsonObject { put("b", "x".repeat(16379)) } }))
        },
      )
      put("children", JsonArray(List(64) { substitutionText("{i.b}") }))
    }
    assertSubstitutionValid(substitutionSpec(root))
    val crossed =
      JsonObject(root + ("children" to JsonArray(List(65) { substitutionText("{i.b}") })))
    assertEquals(
      PrototypeSpecError("root.children[64].text", "Substituted text total limit exceeded"),
      PrototypeRepeatValidator.validate(substitutionSpec(crossed)),
    )
  }

  @Test
  fun `per field substitution error wins before the total charge`() {
    assertSubstitutionError(
      substitutionSpec(
        substitutionList(substitutionText("{item.b}{item.b}"), listOf("x".repeat(8193))),
      ),
      "root.children[0].text",
    )
  }

  private fun substitutionText(text: String): JsonObject = buildJsonObject {
    put("type", "text")
    put("text", text)
  }

  private fun substitutionAction(type: String, field: String, value: String): JsonObject {
    val action = buildJsonObject {
      put("type", type)
      if (type == "setState") put("key", "k")
      put(field, value)
    }
    return JsonObject(substitutionText("tap") + ("onTap" to JsonArray(listOf(action))))
  }

  private fun substitutionList(child: JsonObject, values: List<String>): JsonObject =
    buildJsonObject {
      put("type", "column")
      put(
        "repeat",
        buildJsonObject {
          put("items", JsonArray(values.map { buildJsonObject { put("b", it) } }))
          put("as", "item")
        },
      )
      put("children", JsonArray(listOf(child)))
    }

  private fun substitutionSpec(
    root: JsonObject,
    data: JsonObject? = null,
    state: JsonObject? = null,
  ): JsonObject = buildJsonObject {
    put("id", "substituted")
    put(
      "window",
      buildJsonObject { put("placement", buildJsonObject { put("type", "fullscreen") }) },
    )
    put("root", root)
    if (data != null) put("data", data)
    if (state != null) put("state", state)
  }

  private fun assertSubstitutionValid(input: JsonObject) {
    val result = PrototypeSpecValidator.validate(input.toString())
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
  }

  private fun assertSubstitutionError(input: JsonObject, path: String) {
    val result = PrototypeSpecValidator.validate(input.toString())
    assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
    assertEquals(
      PrototypeSpecError(path, "Substituted text length limit exceeded"),
      (result as PrototypeSpecValidation.Failure).error,
    )
  }

  private data class ConditionCase(val condition: JsonObject, val holds: Boolean)

  companion object {
    private val json = PrototypeSpecValidator.json
    private lateinit var cellInvalid: JsonObject
    private lateinit var cellExact: JsonObject
    private lateinit var amplified: JsonObject
    private lateinit var pointerFixture: JsonObject
    private lateinit var fixtures: Map<File, JsonObject>
    private val conditionData =
      Json.parseToJsonElement("""{"s":"7","n":7,"zero":-0,"b":true,"object":{},"array":[]}""")
        .jsonObject
    private val conditionCases =
      listOf(
          """{"data":"/s","equals":"7"}""" to true,
          """{"data":"/s","equals":7}""" to false,
          """{"data":"/n","equals":7.0}""" to true,
          """{"data":"/n","equals":"7"}""" to false,
          """{"data":"/zero","equals":0}""" to true,
          """{"data":"/b","equals":true}""" to true,
          """{"data":"/b","equals":1}""" to false,
          """{"data":"/missing","notEquals":1}""" to true,
          """{"data":5,"notEquals":1}""" to true,
          """{"data":"/missing","equals":1}""" to false,
          """{"data":"/object","equals":"object"}""" to false,
          """{"data":"/array","equals":0}""" to false,
          """{"data":"/object","notEquals":false}""" to true,
          """{"data":"/array","notEquals":false}""" to true,
          """{"data":"/n","notEquals":7}""" to false,
          """{"data":"/n","gt":6}""" to true,
          """{"data":"/n","gt":7}""" to false,
          """{"data":"/n","lt":8}""" to true,
          """{"data":"/n","lt":7}""" to false,
          """{"data":"/s","gt":0}""" to false,
          """{"data":"/b","lt":2}""" to false,
          """{"data":"/object","gt":0}""" to false,
          """{"data":"/array","lt":2}""" to false,
          """{"data":"/missing","gt":0}""" to false,
          """{"data":"/missing","lt":0}""" to false,
        )
        .map { (condition, holds) ->
          ConditionCase(Json.parseToJsonElement(condition).jsonObject, holds)
        }

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      val base = fixtureDirectory()
      cellInvalid =
        Json.parseToJsonElement(File(base, "invalid/data-repeat-path-cell-limit.json").readText())
          .jsonObject
      cellExact =
        Json.parseToJsonElement(File(base, "valid/data-repeat-path-cells-exact.json").readText())
          .jsonObject
      val item = JsonObject((0 until 200).associate { "f$it" to JsonPrimitive("") })
      val container = cellExact.getValue("root").jsonObject.getValue("children").jsonArray.first()
      amplified = buildJsonObject {
        put("data", buildJsonObject { put("items", JsonArray(List(128) { item })) })
        put(
          "root",
          buildJsonObject {
            put("type", "column")
            put("children", JsonArray(List(1500) { container }))
          },
        )
      }
      PrototypeSpecValidator.validate(cellInvalid.getValue("spec").toString())
      PrototypeSpecValidator.validate(cellExact.toString())
      val directory = File(base, "data")
      pointerFixture =
        Json.parseToJsonElement(File(directory, "pointers.json").readText()).jsonObject
      fixtures =
        File(directory, "resolve")
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
          .associateWith { Json.parseToJsonElement(it.readText()).jsonObject }
      for (fixture in fixtures.values) {
        val result = PrototypeSpecValidator.validate(fixture.getValue("spec").toString())
        if (result is PrototypeSpecValidation.Success) PrototypeDataResolver.resolve(result.spec)
      }
      json.encodeToJsonElement(
        PrototypeStatusEntry.serializer(),
        PrototypeStatusEntry("warm", false, emptyMap(), lastSequence = 0),
      )
    }
  }
}
