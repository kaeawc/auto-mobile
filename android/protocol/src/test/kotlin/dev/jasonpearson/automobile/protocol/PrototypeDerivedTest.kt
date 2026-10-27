package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeDerivedTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmCodec() {
      PrototypeDerivedTest().`derive round trips with repeat`()
    }
  }

  @TestFactory
  fun `unknown derived names in every text field`(): List<DynamicTest> {
    val text = "{derived:missing}"
    val nodes =
      listOf(
        "text" to "\"text\":\"$text\"",
        "text" to "\"spans\":[{\"text\":\"$text\"}]",
        "button" to "\"label\":\"$text\"",
        "fab" to "\"label\":\"$text\"",
        "select" to "\"label\":\"$text\"",
        "select" to "\"options\":[{\"label\":\"$text\"}]",
        "segmentedButton" to "\"options\":[{\"label\":\"$text\"}]",
        "topAppBar" to "\"title\":\"$text\"",
        "topAppBar" to "\"navigationIcon\":{\"label\":\"$text\"}",
        "topAppBar" to "\"actions\":[{\"label\":\"$text\"}]",
        "textField" to "\"trailingIcon\":{\"label\":\"$text\"}",
        "searchBar" to "\"placeholder\":\"$text\"",
        "searchBar" to "\"trailingActions\":[{\"label\":\"$text\"}]",
        "dialog" to "\"title\":\"$text\"",
        "dialog" to "\"text\":\"$text\"",
        "dialog" to "\"confirm\":{\"label\":\"$text\"}",
        "dialog" to "\"dismiss\":{\"label\":\"$text\"}",
        "menu" to "\"items\":[{\"label\":\"$text\"}]",
        "menu" to "\"items\":[{\"trailingText\":\"$text\"}]",
        "snackbar" to "\"text\":\"$text\"",
        "snackbar" to "\"action\":{\"label\":\"$text\"}",
        "textField" to "\"checks\":[{\"message\":\"$text\"}]",
        "row" to "\"swipeActions\":{\"start\":[{\"label\":\"$text\"}]}",
        "row" to "\"swipeActions\":{\"end\":[{\"label\":\"$text\"}]}",
      )
    val samples =
      nodes.map { (type, fields) ->
        Json.parseToJsonElement("""{"type":"$type",$fields}""").jsonObject
      } + requestTextSamples(text)
    return samples.map { node ->
      val paths = mutableListOf<String>()
      fun locate(value: JsonElement, path: String) {
        when (value) {
          is JsonObject ->
            value.forEach { (key, child) ->
              locate(child, PrototypeBindableFields.memberPath(path, key))
            }
          is JsonArray -> value.forEachIndexed { index, child -> locate(child, "$path[$index]") }
          is JsonPrimitive -> if (value.content.contains(text)) paths += path
        }
      }
      locate(node, "root.children[2]")
      val path = paths.single()
      DynamicTest.dynamicTest(path) {
        val context = PrototypeStateChecks.Context()
        context.nodes += PrototypeStateChecks.Located(node, "root.children[2]")
        val error = PrototypeDerivedRules.error(JsonObject(emptyMap()), context)
        assertEquals(PrototypeSpecError(path, "Unknown derived value \"missing\""), error)
      }
    }
  }

  private fun requestTextSamples(text: String): List<JsonObject> {
    val requests =
      listOf(
        "url" to JsonPrimitive("https://e.com/$text"),
        "headers" to buildJsonObject { put("X-Token", text) },
        "query" to buildJsonObject { put("search", text) },
      )
    val samples = mutableListOf<JsonObject>()
    for (event in listOf("onTap", "onLongPress", "onDoubleTap", "onSubmit")) {
      for ((field, value) in requests) {
        samples += buildJsonObject {
          put("type", "searchBar")
          put(
            event,
            buildJsonArray {
              add(
                buildJsonObject {
                  put("type", "request")
                  put(field, value)
                },
              )
            },
          )
        }
      }
    }
    return samples
  }

  @Test
  fun `menu errors follow TypeScript text traversal order`() {
    val node =
      Json.parseToJsonElement(
          """{
      "type":"menu", "items":[{"label":"{derived:label}", "trailingText":"{derived:trailing}"}]
    }""",
        )
        .jsonObject
    val context = PrototypeStateChecks.Context()
    context.nodes += PrototypeStateChecks.Located(node, "root")
    assertEquals(
      PrototypeSpecError("root.items[0].trailingText", "Unknown derived value \"trailing\""),
      PrototypeDerivedRules.error(JsonObject(emptyMap()), context),
    )
  }

  @Test
  fun `request body value bindings and operands stay opaque like TypeScript`() {
    val node =
      Json.parseToJsonElement(
          """{
      "type":"button",
      "onTap":[{"type":"request", "url":"https://e.com", "body":{"value":"{derived:missing}"}},
        {"type":"setState", "key":"input", "value":"{derived:missing}"},
        {"type":"emit", "name":"{derived:missing}"}]
    }""",
        )
        .jsonObject
    val context = PrototypeStateChecks.Context()
    context.nodes += PrototypeStateChecks.Located(node, "root")
    assertNull(PrototypeDerivedRules.error(JsonObject(emptyMap()), context))
  }

  @Test
  fun `derived span grammar preserves malformed names`() {
    assertEquals(
      listOf("valid", "next"),
      PrototypeDerivedText.names("{derived:valid} {derived:bad-name} {derived:} {derived:next}"),
    )
    assertEquals(-1, PrototypeDerivedText.tokenEnd("{derived:unclosed", 0))
  }

  @Test
  fun `derive round trips with repeat`() {
    val entry =
      PrototypeDerivedEntry(
        buildJsonObject { put("value", 12) },
        buildJsonObject { put("number", JsonObject(emptyMap())) },
      )
    val repeat = PrototypeRepeat(listOf(emptyMap()), "item", derive = mapOf("price" to entry))
    val json = PrototypeSpecValidator.json
    assertEquals(
      repeat,
      json.decodeFromString(
        PrototypeRepeat.serializer(),
        json.encodeToString(PrototypeRepeat.serializer(), repeat),
      ),
    )
  }
}
