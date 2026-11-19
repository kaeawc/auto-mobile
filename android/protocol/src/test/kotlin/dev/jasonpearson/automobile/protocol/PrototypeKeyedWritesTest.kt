package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeKeyedWritesTest {
  private fun spec(): String = File(fixtureDirectory(), "valid/keyed-data-writes.json").readText()

  @Test
  fun keyedModelsCapabilitiesAndRefusal() {
    val text = spec()
    val validated = PrototypeSpecValidator.validate(text) as PrototypeSpecValidation.Success
    val actions = (validated.spec.root as PrototypeButtonNode).onTap!!
    assertEquals("id", (actions[0] as PrototypeSetDataAction).where?.field)
    assertEquals("title", (actions[0] as PrototypeSetDataAction).member)
    assertEquals("id", (actions[1] as PrototypeRemoveDataAction).where?.field)
    val required = PrototypeStrictPolicy.required(Json.parseToJsonElement(text).jsonObject)
    assertTrue("prototype_data_actions_v2" in required)
    assertEquals(
      required,
      PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(text.toByteArray()))
        .toSet(),
    )
    assertTrue(PrototypeSpecValidator.validate(text, required) is PrototypeSpecValidation.Success)
    val refused =
      PrototypeSpecValidator.validate(text, required - "prototype_data_actions_v2")
        as PrototypeSpecValidation.Failure
    assertTrue(refused.error.message.contains("prototype_data_actions_v2"))
  }

  @Test
  fun eachKeyedActionRequiresV2WhilePositionalAndOpaqueWritesDoNot() {
    val input = Json.parseToJsonElement(spec()).jsonObject
    val root = input.getValue("root").jsonObject
    val actions = root.getValue("onTap").jsonArray
    for (action in actions) {
      val single =
        JsonObject(input + ("root" to JsonObject(root + ("onTap" to JsonArray(listOf(action))))))
      val required = PrototypeStrictPolicy.required(single)
      assertTrue("prototype_data_actions_v1" in required)
      assertTrue("prototype_data_actions_v2" in required)
      assertTrue(
        PrototypeSpecValidator.validate(single.toString(), required - "prototype_data_actions_v2")
          is PrototypeSpecValidation.Failure,
      )
    }
    val set = actions[0].jsonObject
    val positional = JsonObject(set - setOf("where", "member"))
    val opaque = JsonObject(positional + ("value" to buildJsonObject { put("value", set) }))
    val plain =
      JsonObject(input + ("root" to JsonObject(root + ("onTap" to JsonArray(listOf(opaque))))))
    assertFalse("prototype_data_actions_v2" in PrototypeStrictPolicy.required(plain))
  }

  @Test
  fun strictKeyedActionFields() {
    val text = spec()
    for (invalid in
      listOf(
        text.replace("\"member\": \"title\"", "\"member\": \"a/b\""),
        text.replace("\"field\": \"id\"", "\"field\": \"\""),
        text.replace("\"type\": \"removeData\"", "\"member\": \"title\", \"type\": \"removeData\""),
        text.replace("\"type\": \"setData\"", "\"type\": \"appendData\""),
        text.replace("\"field\": \"id\"", "\"extra\": true, \"field\": \"id\""),
      )) assertTrue(PrototypeSpecValidator.validate(invalid) is PrototypeSpecValidation.Failure)
  }

  @Test
  fun selectorItemAndIndexBindWithoutChangingNamesOrLiteralValues() {
    for (source in listOf("""{"item":"id"}""", """{"index":true}""")) {
      val node =
        Json.parseToJsonElement(
            """{"type":"button","label":"Edit","onTap":[{"type":"removeData","path":"/data/items","where":{"field":"id","equals":$source}}]}""",
          )
          .jsonObject
      val bound =
        PrototypeRepeatNodeBinding.bindNodeFields(node, "row", mapOf("id" to JsonPrimitive(9)), 3)
      val selector = bound.getValue("onTap").jsonArray[0].jsonObject.getValue("where").jsonObject
      assertEquals(JsonPrimitive("id"), selector["field"])
      val expected = if ("item" in source) 9 else 3
      assertEquals(JsonPrimitive(expected), selector.getValue("equals").jsonObject["value"])
    }
  }

  companion object {
    @BeforeAll
    @JvmStatic
    fun warmModels() {
      PrototypeSpecFixtures.loadFixtures()
    }
  }
}
