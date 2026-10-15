package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeRichTextTest {
  private fun validate(root: String, state: String = "{}") =
    PrototypeSpecValidator.validate(
      """{"id":"rich","window":{"placement":{"type":"fullscreen"}},"state":$state,"root":$root}""",
    )

  @Test
  fun `text requires exactly one content form before checking fields`() {
    val both =
      validate("""{"type":"text","text":17,"spans":[]}""") as PrototypeSpecValidation.Failure
    assertEquals(PrototypeSpecError("root.spans", "text and spans cannot both be set"), both.error)
    val neither = validate("""{"type":"text"}""") as PrototypeSpecValidation.Failure
    assertEquals(PrototypeSpecError("root.text", "text node needs text or spans"), neither.error)
    val oversized = (1..65).joinToString(",") { """{"text":""}""" }
    val limit =
      validate("""{"type":"text","spans":[$oversized]}""") as PrototypeSpecValidation.Failure
    assertEquals(64, PrototypeSpecValidator.MAX_PROTOTYPE_TEXT_SPANS)
    assertEquals(PrototypeSpecError("root.spans", "Text span limit exceeded"), limit.error)
  }

  @Test
  fun `plain text concatenates resolved span fields without a separator`() {
    val node = PrototypeTextNode(spans = listOf(PrototypeTextSpan("a"), PrototypeTextSpan("b")))
    assertEquals("ab", prototypePlainText(node))
    assertEquals("AB", prototypePlainText(node) { it.uppercase() })
    assertEquals("plain", prototypePlainText(PrototypeTextNode(text = "plain")))
    assertTrue(validate("""{"type":"text","text":"plain"}""") is PrototypeSpecValidation.Success)
  }

  @Test
  fun `data and repeat binding share the text field walker for spans and actions`() {
    val root =
      Json.parseToJsonElement(
          """{"type":"text","spans":[{"text":"{data:/title} {item.title}","onTap":[{"type":"emit","name":"{item.event}"},{"type":"toggle","key":"liked_{item.id}"}]}]}""",
        )
        .jsonObject
    val resolved = PrototypeDataResolver.resolveRoot(root, buildJsonObject { put("title", "Data") })
    val bound = mutableMapOf<String, String>()
    val item =
      mapOf(
        "title" to JsonPrimitive("Repeat"),
        "event" to JsonPrimitive("tap"),
        "id" to JsonPrimitive("1"),
      )
    PrototypeBindableFields.first<Boolean>(resolved, "root") { value, path, _ ->
      val text = (value as? JsonPrimitive)?.content
      if (text != null) bound[path] = PrototypeRepeatTemplate.bind(text, "item", item, 0)
      null
    }
    assertEquals("Data Repeat", bound["root.spans[0].text"])
    assertEquals("tap", bound["root.spans[0].onTap[0].name"])
    assertEquals("liked_1", bound["root.spans[0].onTap[1].key"])
  }

  @Test
  fun `span actions participate in state type and state write validation`() {
    val root =
      """{"type":"text","spans":[{"text":"toggle","onTap":[{"type":"toggle","key":"liked"}]}]}"""
    val bad = validate(root, """{"liked":1}""") as PrototypeSpecValidation.Failure
    assertEquals(
      PrototypeSpecError("root.spans[0].onTap[0].key", "Toggle requires a boolean state key"),
      bad.error,
    )
    val good = validate(root, """{"liked":false}""") as PrototypeSpecValidation.Success
    val writes = PrototypeSpecValidator.prepareStateWrites(good.spec, PrototypeSpecValidator.json)
    assertEquals(
      bad.error,
      writes.validate(mapOf("liked" to PrototypeScalar.Numeric(1.0))),
    )
    assertNull(writes.validate(mapOf("liked" to PrototypeScalar.BooleanValue(true))))
  }

  @Test
  fun `host expanded props fixture preserves span text and actions`() {
    val decoded = PrototypeSpecValidator.validate(propsExpanded) as PrototypeSpecValidation.Success
    val node = decoded.spec.root as PrototypeTextNode
    assertEquals("Terms", prototypePlainText(node))
    assertEquals(listOf(PrototypeEmitAction("terms")), node.spans!!.single().onTap)
  }

  companion object {
    private lateinit var propsExpanded: String

    @BeforeAll
    @JvmStatic
    fun warm() {
      propsExpanded =
        Json.parseToJsonElement(
            File(fixtureDirectory(), "components/expand/text-spans-props.json").readText(),
          )
          .jsonObject
          .getValue("expanded")
          .toString()
      PrototypeSpecValidator.validate(propsExpanded)
      PrototypeDataResolver.resolveRoot(
        buildJsonObject {
          put("type", "text")
          put("text", "warm")
        },
        null,
      )
    }
  }
}
