package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeDeadTapsTest {
  @Test
  fun `window dead taps decodes nullable opt in and round trips`() {
    for (enabled in listOf(null, false, true)) {
      val input = spec(enabled?.let { ",\"deadTaps\":$it" } ?: "")
      val decoded = Json.decodeFromString<PrototypeSpec>(input)
      assertEquals(enabled, decoded.window.deadTaps)
      assertEquals(
        decoded,
        Json.decodeFromString<PrototypeSpec>(
          Json.encodeToString(PrototypeSpec.serializer(), decoded),
        ),
      )
      // Window options are preflight capabilities, never strict-policy gates.
      assertTrue(
        PrototypeSpecValidator.validate(input, emptySet()) is PrototypeSpecValidation.Success,
      )
    }
  }

  @Test
  fun `window dead taps rejects non boolean values at the field`() {
    for (invalid in listOf("1", "\"true\"", "null", "{}", "[]")) {
      val result = PrototypeSpecValidator.validate(spec(",\"deadTaps\":$invalid"))
      assertTrue(result is PrototypeSpecValidation.Failure)
      assertEquals("window.deadTaps", (result as PrototypeSpecValidation.Failure).error.path)
    }
  }

  @Test
  fun `authored emits cannot impersonate runtime events`() {
    for (name in
      listOf(PrototypeDeadTaps.EVENT_NAME, PrototypeRequests.EVENT_NAME, "prototype_other")) {
      val input =
        spec("", """{"type":"text","text":"Tap","onTap":[{"type":"emit","name":"$name"}]}""")
      val result = PrototypeSpecValidator.validate(input)
      assertTrue(result is PrototypeSpecValidation.Failure)
      assertEquals("root.onTap[0].name", (result as PrototypeSpecValidation.Failure).error.path)
    }
  }

  companion object {
    private fun spec(window: String, root: String = """{"type":"text","text":"Dead"}""") =
      """{"id":"dead","window":{"placement":{"type":"fullscreen"}$window},"root":$root}"""

    @BeforeAll
    @JvmStatic
    fun warmValidator() {
      PrototypeSpecValidator.validate(spec(""))
    }
  }
}
