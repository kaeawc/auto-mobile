package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

/** `linkify` (#14233): the shared detection cases and `{match}` binding. */
class PrototypeLinkifyTest {
  companion object {
    private lateinit var repeatSpecs: List<String>

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      repeatSpecs =
        listOf("linkify-repeat-binding", "linkify-repeat-rows", "linkify-repeat-data-rows").map {
          File(fixtureDirectory(), "valid/$it.json").readText()
        }
      // Keep JVM serializer initialization outside the per-test budget, as in the corpus suites.
      PrototypeSpecValidator.validate(repeatSpecs[1])
    }
  }

  @Test
  fun `repeat-bound linkify fixtures validate`() {
    for (spec in repeatSpecs) {
      val result = PrototypeSpecValidator.validate(spec)
      assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    }
  }

  @Test
  fun `shared detection cases match`() {
    val cases =
      Json.parseToJsonElement(File(fixtureDirectory(), "linkify/cases.json").readText()).jsonArray
    assertTrue(cases.size > 10)
    for (entry in cases.map { it.jsonObject }) {
      val text = entry.getValue("text").jsonPrimitive.content
      val kinds = entry.getValue("kinds").jsonArray.map { it.jsonPrimitive.content }
      val expected =
        entry.getValue("matches").jsonArray.map {
          val match = it.jsonObject
          PrototypeLinkify.Match(
            match.getValue("kind").jsonPrimitive.content,
            match.getValue("text").jsonPrimitive.content,
            match.getValue("start").jsonPrimitive.int,
            match.getValue("end").jsonPrimitive.int,
          )
        }
      assertEquals(expected, PrototypeLinkify.matches(text, kinds), text)
    }
  }

  @Test
  fun `match bindings fill setState literals and value bindings but not literals or payloads`() {
    val onTap =
      Json.parseToJsonElement(
          """[{"type":"setState","key":"handle","value":{"match":"text"}},
          {"type":"emit","name":"x","context":{"kind":{"match":"kind"}},"payload":{"match":"text"}},
          {"type":"setData","path":"/data/last","value":{"value":{"match":"text"}}}]""",
        )
        .jsonArray
    val actions = PrototypeLinkify.actions(onTap, PrototypeLinkify.Match("mention", "@ana", 0, 4))
    assertEquals(PrototypeScalar.Text("@ana"), (actions[0] as PrototypeSetStateAction).value)
    val emit = actions[1] as PrototypeEmitAction
    assertEquals(
      Json.parseToJsonElement("""{"match":"text"}"""),
      emit.payload,
    )
    assertEquals(
      Json.parseToJsonElement("""{"value":{"match":"text"}}"""),
      Json.parseToJsonElement(
        PrototypeLinkify.bind(onTap, PrototypeLinkify.Match("mention", "@ana", 0, 4))
          .let { it as JsonArray }[2]
          .jsonObject
          .getValue("value")
          .toString(),
      ),
    )
  }

  @Test
  fun `a validated linkify spec decodes its options`() {
    val spec =
      """{"id":"l","window":{"placement":{"type":"fullscreen"}},"state":{"h":""},
      "root":{"type":"text","text":"Hi @ana","linkify":{"kinds":["mention"],
      "onTap":[{"type":"setState","key":"h","value":{"match":"text"}}]}}}"""
    val result = PrototypeSpecValidator.validate(spec)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val node = (result as PrototypeSpecValidation.Success).spec.root as PrototypeTextNode
    assertEquals(listOf("mention"), node.linkify?.kinds)
  }
}
