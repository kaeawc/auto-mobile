package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeNestedRepeatTest {
  companion object {
    private val directory = fixtureDirectory()
    private val cases =
      Json.parseToJsonElement(File(directory, "repeat/nested.json").readText()).jsonArray

    private fun input(case: JsonObject): JsonObject =
      JsonObject(
        case.getValue("spec").jsonObject + case.filterKeys { it == "data" || it == "state" },
      )

    @JvmStatic
    @BeforeAll
    fun warm() {
      PrototypeSpecValidator.validate(input(cases.first().jsonObject).toString())
    }
  }

  @TestFactory
  fun `shared valid nested fixtures validate and round trip`(): List<DynamicTest> =
    cases.map { raw ->
      val case = raw.jsonObject
      DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
        val spec = input(case)
        val result = PrototypeSpecValidator.validate(spec.toString())
        assertTrue(result is PrototypeSpecValidation.Success, "$result")
        val decoded = (result as PrototypeSpecValidation.Success).spec
        val encoded = PrototypeSpecValidator.json.encodeToJsonElement(decoded)
        assertEquals(
          decoded,
          PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeSpec>(encoded),
        )
        assertTrue(
          PrototypeSpecValidator.validate(encoded.toString()) is PrototypeSpecValidation.Success,
        )
        assertTrue("prototype_nested_repeat_v1" in PrototypeStrictPolicy.required(spec))
        assertTrue(
          "prototype_nested_repeat_v1" in
            PrototypeBundleCapabilities.required(
              PrototypeBundleSpec.references(spec.toString().toByteArray()),
            ),
        )
      }
    }

  @TestFactory
  fun `shared invalid nested fixtures retain exact errors`(): List<DynamicTest> =
    File(directory, "invalid")
      .listFiles()
      .orEmpty()
      .filter {
        it.name.startsWith("nested-repeat-") ||
          it.name == "strict-gate-prototype_nested_repeat_v1.json"
      }
      .sortedBy { it.name }
      .map { file ->
        val fixture = Json.parseToJsonElement(file.readText()).jsonObject
        DynamicTest.dynamicTest(file.name) {
          val supported =
            fixture["options"]
              ?.jsonObject
              ?.get("supportedCapabilities")
              ?.jsonArray
              ?.map { it.jsonPrimitive.content }
              ?.toSet()
          val result =
            PrototypeSpecValidator.validate(fixture.getValue("spec").toString(), supported)
          assertTrue(result is PrototypeSpecValidation.Failure, "$result")
          val error = (result as PrototypeSpecValidation.Failure).error
          assertEquals(fixture.getValue("expectedPath").jsonPrimitive.content, error.path)
          assertEquals(
            fixture["expectedMessage"]?.jsonPrimitive?.content
              ?: "Unsupported capabilities: prototype_nested_repeat_v1",
            error.message,
          )
        }
      }

  @Test
  fun `strict policy negotiates the nested gate`() {
    val spec = input(cases.first().jsonObject)
    val required = PrototypeStrictPolicy.required(spec)
    assertTrue(
      PrototypeSpecValidator.validate(spec.toString(), required) is PrototypeSpecValidation.Success,
    )
    assertEquals(
      PrototypeSpecError("$", "Unsupported capabilities: prototype_nested_repeat_v1"),
      (PrototypeSpecValidator.validate(spec.toString(), required - "prototype_nested_repeat_v1")
          as PrototypeSpecValidation.Failure)
        .error,
    )
    // Data payloads are opaque, even when their keys look like a spec feature.
    val opaque =
      """{"id":"opaque","window":{"placement":{"type":"fullscreen"}},"data":{"repeat":{"items":{"field":"lines"}}},"root":{"type":"text","text":"ok"}}"""
    assertFalse(
      "prototype_nested_repeat_v1" in
        PrototypeStrictPolicy.required(Json.parseToJsonElement(opaque).jsonObject),
    )
  }

  @Test
  fun `representative orders validate`() {
    val result =
      PrototypeSpecValidator.validate(File(directory, "repeat/nested-orders.json").readText())
    assertTrue(result is PrototypeSpecValidation.Success, "$result")
  }

  private fun nested(
    outerCount: Int,
    innerCount: Int,
    child: JsonObject =
      Json.parseToJsonElement(
          """{"type":"text","text":"{order.id}/{outerIndex}/{line.sku}/{index}"}""",
        )
        .jsonObject,
  ): JsonObject {
    val source = input(cases.first().jsonObject)
    val root = source.getValue("root").jsonObject
    val inner = root.getValue("children").jsonArray[0].jsonObject
    return JsonObject(
      source +
        mapOf(
          "data" to
            buildJsonObject {
              put(
                "orders",
                JsonArray(
                  (0 until outerCount).map { outer ->
                    buildJsonObject {
                      put("id", outer)
                      put(
                        "lines",
                        JsonArray((0 until innerCount).map { buildJsonObject { put("sku", it) } }),
                      )
                    }
                  },
                ),
              )
            },
          "root" to
            JsonObject(
              root +
                ("children" to
                  JsonArray(listOf(JsonObject(inner + ("children" to JsonArray(listOf(child))))))),
            ),
        ),
    )
  }

  private fun error(spec: JsonObject): PrototypeSpecError =
    (PrototypeSpecValidator.validate(spec.toString()) as PrototypeSpecValidation.Failure).error

  @Test
  fun `inner item cap is read from the shared contract`() {
    assertEquals(100, PrototypeSpecValidator.MAX_PROTOTYPE_INNER_REPEAT_ITEMS)
    assertTrue(
      PrototypeSpecValidator.validate(nested(2, 100).toString()) is PrototypeSpecValidation.Success,
    )
    assertEquals(
      PrototypeSpecError(
        "root.children[0].repeat.items.field",
        "Repeat field resolves to more than 100 items",
      ),
      error(nested(1, 101)),
    )
  }

  @Test
  fun `expanded nodes and images count every pair`() {
    assertEquals("Expanded node limit exceeded", error(nested(20, 100)).message)
    val image = Json.parseToJsonElement("""{"type":"image","asset":"photo"}""").jsonObject
    assertTrue(
      PrototypeSpecValidator.validate(nested(2, 16, image).toString())
        is PrototypeSpecValidation.Success,
    )
    assertEquals("Expanded image limit exceeded", error(nested(3, 11, image)).message)
  }

  @Test
  fun `motion budgets count nested instances`() {
    val icon =
      Json.parseToJsonElement(
          """{"type":"icon","name":"favorite","keyframes":{"trigger":{"key":"liked"},"durationMs":600,"tracks":{"scale":[[0,1],[0.5,1.3],[1,1]]}}}""",
        )
        .jsonObject
    val source =
      JsonObject(nested(3, 6, icon) + ("state" to buildJsonObject { put("liked", false) }))
    assertEquals("Keyframe node limit exceeded", error(source).message)
  }

  @Test
  fun `empty outer source still rejects third nesting level`() {
    val third =
      Json.parseToJsonElement(
          """{"type":"column","repeat":{"items":{"field":"lines"},"as":"third"},"children":[]}""",
        )
        .jsonObject
    assertEquals("Repeat nesting depth exceeds 2", error(nested(0, 0, third)).message)
  }

  @Test
  fun `bound state keys validate every outer inner pair`() {
    val child =
      Json.parseToJsonElement(
          """{"type":"switch","stateKey":"selected_{order.id}_{outerIndex}_{line.sku}_{index}"}""",
        )
        .jsonObject
    val source = nested(2, 2, child)
    val state = buildJsonObject {
      for (outer in 0..1) for (inner in 0..1) put(
        "selected_${outer}_${outer}_${inner}_$inner",
        true,
      )
    }
    assertTrue(
      PrototypeSpecValidator.validate(JsonObject(source + ("state" to state)).toString())
        is PrototypeSpecValidation.Success,
    )
    assertEquals(
      "Toggle control requires a boolean state key (repeat item 1)",
      error(JsonObject(source + ("state" to JsonObject(state - "selected_1_1_1_1")))).message,
    )
  }
}

class PrototypeNestedRepeatPolicyTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      PrototypeNestedRepeatPolicyTest().`nested secure keys remain protected`()
    }
  }

  @Test
  fun `nested secure keys remain protected`() {
    val child =
      Json.parseToJsonElement(
          """{"type":"column","children":[{"type":"textField","stateKey":"secret_{outerIndex}_{index}","secure":true},{"type":"button","label":"Send","onTap":[{"type":"emit","name":"send","context":{"token":{"state":"secret_{outerIndex}_{index}"}}}]}]}""",
        )
        .jsonObject
    val original =
      Json.parseToJsonElement(File(fixtureDirectory(), "repeat/nested-orders.json").readText())
        .jsonObject
    val root = original.getValue("root").jsonObject
    val inner =
      Json.parseToJsonElement(
          """{"type":"column","repeat":{"items":{"field":"lines"},"as":"line"}}""",
        )
        .jsonObject
    val template = JsonObject(inner + ("children" to JsonArray(listOf(child))))
    val repeated = JsonObject(root + ("children" to JsonArray(listOf(template))))
    val source =
      JsonObject(
        original +
          mapOf(
            "root" to repeated,
            "state" to
              buildJsonObject {
                put("secret_0_0", "")
                put("secret_0_1", "")
                put("secret_1_0", "")
              },
          ),
      )
    assertTrue(
      PrototypeSpecValidator.validate(source.toString()) is PrototypeSpecValidation.Success,
    )
    val result =
      PrototypeSpecValidator.validate(source.toString(), library = true)
        as PrototypeSpecValidation.Failure
    assertEquals("Secure value cannot be bound into an action payload", result.error.message)
    assertEquals(
      "root.children[0].children[0].children[1].onTap[0].context.token.state",
      result.error.path,
    )
  }
}
