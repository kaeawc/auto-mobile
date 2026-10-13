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
        "MAX_PROTOTYPE_DATA_BYTES" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_BYTES,
        "MAX_PROTOTYPE_DATA_DEPTH" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_DEPTH,
        "MAX_PROTOTYPE_DATA_ARRAY_ITEMS" to PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
        "MAX_PROTOTYPE_DATA_POINTER_LENGTH" to
          PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
      )
    for ((name, value) in actual) assertEquals(limits.getValue(name).jsonPrimitive.int, value)
  }

  private data class ConditionCase(val condition: JsonObject, val holds: Boolean)

  companion object {
    private val json = PrototypeSpecValidator.json
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
      val directory = File(fixtureDirectory(), "data")
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
