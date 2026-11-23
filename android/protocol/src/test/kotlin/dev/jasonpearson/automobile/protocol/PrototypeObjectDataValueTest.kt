package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

/** `{object}` data-action values (#18826). */
class PrototypeObjectDataValueTest {
  private fun fixture(name: String): String = File(fixtureDirectory(), "valid/$name").readText()

  private val inputs =
    object : EmitContextInputs {
      override fun state(key: String): JsonElement? =
        if (key == "draft") JsonPrimitive("Buy milk") else null

      override fun page(id: String): Int? = null

      override fun data(pointer: String): JsonElement? =
        if (pointer == "/todos/0/title") JsonPrimitive("Walk dog") else null

      override fun derived(name: String): JsonElement? =
        if (name == "label") JsonPrimitive("BUY MILK") else null
    }

  private fun binding(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

  @Test
  fun objectWritesRequireV3InStrictAndBundleChecks() {
    for (name in listOf("data-object-append.json", "data-object-repeat.json")) {
      val text = fixture(name)
      assertTrue(PrototypeSpecValidator.validate(text) is PrototypeSpecValidation.Success)
      val required = PrototypeStrictPolicy.required(Json.parseToJsonElement(text).jsonObject)
      assertTrue("prototype_data_actions_v1" in required)
      assertTrue("prototype_data_actions_v3" in required)
      assertEquals(
        required,
        PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(text.toByteArray()))
          .toSet(),
      )
      val refused =
        PrototypeSpecValidator.validate(text, required - "prototype_data_actions_v3")
          as PrototypeSpecValidation.Failure
      assertTrue(refused.error.message.contains("prototype_data_actions_v3"))
    }
    val flat = fixture("data-actions-list.json")
    assertFalse(
      "prototype_data_actions_v3" in
        PrototypeStrictPolicy.required(Json.parseToJsonElement(flat).jsonObject),
    )
  }

  @Test
  fun membersResolveLikeTopLevelValuesAndAMissingSourceFails() {
    val resolved =
      PrototypeDataWriter.resolveValue(
        binding(
          """{"object":{"title":{"state":"draft"},"from":{"data":"/todos/0/title"},"done":{"value":false}}}""",
        ),
        inputs,
      ) as PrototypeDataValue.Resolved
    assertEquals(
      binding("""{"title":"Buy milk","from":"Walk dog","done":false}"""),
      resolved.value,
    )
    val missingState =
      PrototypeDataWriter.resolveValue(binding("""{"object":{"t":{"state":"nope"}}}"""), inputs)
        as PrototypeDataValue.Failure
    assertEquals(PrototypeDataWriteErrorCode.INVALID_VALUE, missingState.error.code)
    val missingData =
      PrototypeDataWriter.resolveValue(binding("""{"object":{"t":{"data":"/nope"}}}"""), inputs)
        as PrototypeDataValue.Failure
    assertEquals(PrototypeDataWriteErrorCode.NOT_FOUND, missingData.error.code)
    assertTrue(
      PrototypeDataWriter.resolveValue(
        binding("""{"object":{"t":{"object":{"u":{"value":1}}}}}"""),
        inputs,
      ) is PrototypeDataValue.Failure,
    )
  }

  @Test
  fun derivedMembersResolveLikeTopLevelDerivedValues() {
    val top =
      PrototypeDataWriter.resolveValue(binding("""{"derived":"label"}"""), inputs)
        as PrototypeDataValue.Resolved
    val member =
      PrototypeDataWriter.resolveValue(binding("""{"object":{"t":{"derived":"label"}}}"""), inputs)
        as PrototypeDataValue.Resolved
    assertEquals(buildJsonObject { put("t", top.value) }, member.value)
    assertTrue(
      PrototypeDataWriter.resolveValue(binding("""{"object":{"t":{"derived":"nope"}}}"""), inputs)
        is PrototypeDataValue.Failure,
    )
  }

  @Test
  fun unknownDerivedMemberIsRefusedAtLoad() {
    val failure =
      PrototypeSpecValidator.validate(
        """{"id":"todo","window":{"placement":{"type":"fullscreen"}},"state":{"ratio":0.25},"derive":{"label":{"of":{"state":"ratio"},"format":{"percent":{}}}},"data":{"todo":{}},"root":{"type":"button","label":"Save","onTap":[{"type":"setData","path":"/data/todo","value":{"object":{"t":{"derived":"missing"}}}}]}}""",
      ) as PrototypeSpecValidation.Failure
    assertEquals("root.onTap[0].value.object.t.derived", failure.error.path)
    assertEquals("Unknown derived value \"missing\"", failure.error.message)
  }

  @Test
  fun repeatItemAndIndexMembersBindPerRow() {
    val node =
      binding(
        """{"type":"button","label":"Archive","onTap":[{"type":"appendData","path":"/data/archive","value":{"object":{"title":{"item":"title"},"at":{"index":true},"done":{"value":true}}}}]}""",
      )
    val item = mapOf("title" to JsonPrimitive("Walk dog"))
    val expected =
      binding(
        """{"object":{"title":{"value":"Walk dog"},"at":{"value":2},"done":{"value":true}}}""",
      )
    val bound = PrototypeRepeatNodeBinding.bindNodeFields(node, "todo", item, 2)
    assertEquals(expected, bound.getValue("onTap").jsonArray[0].jsonObject["value"])
    val value = node.getValue("onTap").jsonArray[0].jsonObject.getValue("value").jsonObject
    assertEquals(expected, PrototypeObjectDataValue.bindToRow(value, "todo", item, 2))
  }

  @Test
  fun upsertKeyMustStartWithAMember() {
    fun upsert(key: String, members: String): PrototypeSpecValidation =
      PrototypeSpecValidator.validate(
        """{"id":"todo","window":{"placement":{"type":"fullscreen"}},"state":{"draft":"x"},"data":{"todos":[]},"root":{"type":"button","label":"Add","onTap":[{"type":"upsertData","path":"/data/todos","key":"$key","value":{"object":$members}}]}}""",
      )
    assertTrue(
      upsert("/title", """{"title":{"state":"draft"}}""") is PrototypeSpecValidation.Success,
    )
    assertTrue(
      upsert("/meta/id", """{"meta":{"value":{"id":1}}}""") is PrototypeSpecValidation.Success,
    )
    assertTrue(upsert("/id", """{"id":{"value":7}}""") is PrototypeSpecValidation.Success)
    for ((key, members) in
      listOf(
        "/id" to """{"title":{"state":"draft"}}""",
        "/id" to """{"id":{"value":null}}""",
        "/meta/id" to """{"meta":{"value":{"other":1}}}""",
      )) {
      val failure = upsert(key, members) as PrototypeSpecValidation.Failure
      assertEquals("root.onTap[0].key", failure.error.path)
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
