package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeStylePolishV2Test {
  @Test
  fun `style polish requires capability in conditional styles`() {
    val node =
      Json.parseToJsonElement(
          """{"type":"box","styleWhen":[{"style":{"cornerStyle":"continuous"}}]}""",
        )
        .jsonObject
    assertTrue(PrototypeStylePolishV2Rules.required(node))
    assertEquals("prototype_style_polish_v2", PrototypeStylePolishV2Rules.CAPABILITY)
    assertFalse(
      PrototypeStylePolishV2Rules.required(
        Json.parseToJsonElement("""{"type":"box","data":{"shadows":[]}}""").jsonObject,
      ),
    )
  }

  @Test
  fun `shadows exclude zero elevation and shadow color at the authored path`() {
    for (other in listOf("\"elevation\":0", "\"shadowColor\":\"#000000\"")) {
      val style =
        Json.parseToJsonElement("""{"shadows":[{"color":"#000000","radius":1}],$other}""")
          .jsonObject
      val error = PrototypeStylePolishV2Rules.objectError(style, "style", "root.style")
      assertEquals("root.style.shadows", error?.path)
      assertEquals("shadows cannot be combined with elevation or shadowColor", error?.message)
    }
  }

  @Test
  fun `generated layer model preserves authored fields`() {
    val shadow =
      Json.decodeFromString<PrototypeShadow>(
        """{"color":"scrim","radius":0,"spread":-2,"inner":true,"offset":{"x":1,"y":-1}}""",
      )
    assertEquals(-2.0, shadow.spread)
    assertEquals(true, shadow.inner)
    assertEquals(PrototypeShadowOffset(1.0, -1.0), shadow.offset)
  }
}
