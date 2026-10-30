package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypePrependDataTest {
  private fun json(text: String) = Json.parseToJsonElement(text)

  private val before = json("""{"items":[3,4],"other":true}""").jsonObject

  @Test
  fun pageOrderAndEndTrimmingAreImmutable() {
    val result =
      PrototypeDataWriter.apply(
        before,
        PrototypeDataWrite.Prepend("/data/items", json("[1,2]"), 3),
      ) as PrototypeDataWriteResult.Success
    assertEquals(json("""{"items":[1,2,3],"other":true}"""), result.data)
    assertEquals(1, result.trimmed)
    assertEquals(json("[3,4]"), before["items"])
  }

  @Test
  fun trimRunsBeforeFinalDataLimits() {
    val page =
      JsonArray(
        List(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS + 1) { JsonPrimitive(it) },
      )
    val result =
      PrototypeDataWriter.apply(before, PrototypeDataWrite.Prepend("/data/items", page, 1))
        as PrototypeDataWriteResult.Success
    assertEquals(json("[0]"), result.data["items"])
    assertEquals(page.size + 1, result.trimmed)
  }

  @Test
  fun untrimmedPageStillEnforcesFinalLimits() {
    val page =
      JsonArray(List(PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS) { JsonPrimitive(it) })
    val result =
      PrototypeDataWriter.apply(before, PrototypeDataWrite.Prepend("/data/items", page))
        as PrototypeDataWriteResult.Failure
    assertEquals(PrototypeDataWriteErrorCode.LIMIT_EXCEEDED, result.error.code)
  }

  @Test
  fun typedFailuresIdentifyPrependData() {
    val cases =
      listOf(
        PrototypeDataWrite.Prepend("/data/items", json("1")) to
          PrototypeDataWriteErrorCode.INVALID_VALUE,
        PrototypeDataWrite.Prepend("/data/missing", json("[]")) to
          PrototypeDataWriteErrorCode.NOT_FOUND,
        PrototypeDataWrite.Prepend("/data/other", json("[]")) to
          PrototypeDataWriteErrorCode.NOT_ARRAY,
        PrototypeDataWrite.Prepend("/data/items", json("[]"), 0) to
          PrototypeDataWriteErrorCode.INVALID_VALUE,
      )
    for ((write, code) in cases) {
      val result = PrototypeDataWriter.apply(before, write) as PrototypeDataWriteResult.Failure
      assertEquals(code, result.error.code)
      assertTrue(result.error.message.contains("prependData"))
    }
  }

  private fun spec(target: String = "items") =
    """{"id":"prepend","window":{"placement":{"type":"fullscreen"}},
      "data":{"items":[],"other":true},"root":{"type":"button","label":"Load",
      "onTap":[{"type":"prependData","path":"/data/$target","value":{"value":[1,2]}}]}}"""

  @Test
  fun actionDecodesAndRequiresBothNegotiatedCapabilities() {
    val text = spec()
    val result = PrototypeSpecValidator.validate(text) as PrototypeSpecValidation.Success
    val root = result.spec.root as PrototypeButtonNode
    assertTrue(root.onTap!!.single() is PrototypePrependDataAction)
    val required = PrototypeStrictPolicy.required(json(text).jsonObject)
    assertEquals(
      required,
      PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(text.toByteArray()))
        .toSet(),
    )
    assertTrue(required.containsAll(setOf("prototype_data_actions_v1", "prototype_lazy_list_v1")))
    for (capability in listOf("prototype_data_actions_v1", "prototype_lazy_list_v1")) {
      assertTrue(
        PrototypeSpecValidator.validate(text, required - capability)
          is PrototypeSpecValidation.Failure,
      )
    }
    val failure = PrototypeSpecValidator.validate(spec("other")) as PrototypeSpecValidation.Failure
    assertEquals("prependData target is not an array", failure.error.message)
  }

  @Test
  fun eventPageIsReplayableAndOmittedValuesStopReplay() {
    val payload = json("""{"op":"prepend","value":[1,2],"maxItems":3,"revision":7}""")
    val event = prototypeDataWriteOf("change", "/data/items", payload)!!
    assertEquals(PrototypeDataWrite.Prepend("/data/items", json("[1,2]"), 3L), event.write())
    assertEquals(payload, event.payload())
    val omitted =
      prototypeDataWriteOf("change", "/data/items", json("""{"op":"prepend","revision":8}"""))
    assertNotNull(omitted)
    assertNull(omitted!!.write())
    assertNull(
      prototypeDataWriteOf(
        "change",
        "/data/items",
        json("""{"op":"prepend","value":1,"revision":8}"""),
      ),
    )
  }

  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      PrototypeSpecFixtures.loadFixtures()
      PrototypeDataWriter.apply(
        JsonObject(emptyMap()),
        PrototypeDataWrite.Prepend("/data/missing", JsonArray(emptyList())),
      )
    }
  }
}
