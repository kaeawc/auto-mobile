package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeGesturesTest {
  @Test
  fun `all seven gesture node models decode both lists`() {
    for (node in nodes) {
      assertEquals(listOf(PrototypeEmitAction("hold")), node.onLongPress)
      assertEquals(listOf(PrototypeEmitAction("double")), node.onDoubleTap)
      assertNull(node.onTap)
    }
  }

  @Test
  fun `button refuses either gesture field at the field path`() {
    for (field in listOf("onLongPress", "onDoubleTap")) {
      val result =
        PrototypeSpecValidator.validate(
          envelope("""{"type":"button","label":"Go","$field":[{"type":"emit","name":"hold"}]}"""),
        ) as PrototypeSpecValidation.Failure
      assertEquals("root.$field", result.error.path)
    }
  }

  @Test
  fun `repeat gesture names and state keys use the existing binding grammar`() {
    val item = JsonObject(mapOf("id" to JsonPrimitive("a")))
    assertEquals(
      "hold_a_2",
      PrototypeRepeatTemplate.bind("hold_{item.id}_{index}", "item", item, 2),
    )
    for (field in listOf("onLongPress", "onDoubleTap")) {
      val input =
        envelope(
          """{"type":"column","repeat":{"as":"item","items":[{"id":"a"}]},"children":[{"type":"text","text":"Hold","$field":[{"type":"setState","key":"picked_{item.id}","value":"{index}"},{"type":"emit","name":"hold_{item.id}_{index}"}]}]}""",
          ""","state":{"picked_a":0}""",
        )
      assertTrue(PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success)
      val rejected =
        PrototypeSpecValidator.validate(input.replace("hold_{item.id}", "hold_{item.missing}"))
          as PrototypeSpecValidation.Failure
      assertEquals("root.children[0].$field[1].name", rejected.error.path)
    }
  }

  companion object {
    private lateinit var nodes: List<PrototypeNode>

    private fun envelope(root: String, extra: String = "") =
      """{"id":"gestures","window":{"placement":{"type":"fullscreen"}},"root":$root$extra}"""

    @BeforeAll
    @JvmStatic
    fun prepareModels() {
      val variants =
        listOf(
          """"type":"box","children":[]""",
          """"type":"row","children":[]""",
          """"type":"column","children":[]""",
          """"type":"text","text":"Hold"""",
          """"type":"image","asset":"hero"""",
          """"type":"icon","name":"Home"""",
          """"type":"card","children":[]""",
        )
      nodes = variants.map { fields ->
        Json.decodeFromString(
            PrototypeSpec.serializer(),
            envelope(
              """{$fields,"onLongPress":[{"type":"emit","name":"hold"}],"onDoubleTap":[{"type":"emit","name":"double"}]}""",
            ),
          )
          .root
      }
      // Warm the contract and serializer outside measured unit tests.
      PrototypeSpecValidator.validate(envelope("""{"type":"text","text":"Warm"}"""))
    }
  }
}
