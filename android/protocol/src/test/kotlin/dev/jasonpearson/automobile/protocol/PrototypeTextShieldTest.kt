package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class PrototypeTextShieldTest {
  private val mark = PrototypeTextShield.MARK

  @Test
  fun `shielded values round-trip exactly and hide every key-opening brace`() {
    val values =
      listOf("{count}", "{derived:x}", "{data:/a}", "{item.t}", "{{a}}", "{1} {", "{${mark}x}", "")
    for (value in values) {
      assertEquals(value, PrototypeTextShield.unshield(PrototypeTextShield.shield(value)), value)
    }
    assertEquals("{${mark}count} {1}", PrototypeTextShield.shield("{count} {1}"))
    assertEquals("plain", PrototypeTextShield.unshield("plain"))
  }

  @Test
  fun `only a renderer's resolution shields inserted data`() {
    val spec =
      PrototypeSpec(
        "shield",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeTextNode(text = "{data:/note} {key}"),
        data = buildJsonObject { put("note", "{key}") },
      )
    val contract = PrototypeDataResolver.resolve(spec).root as PrototypeTextNode
    assertEquals("{key} {key}", contract.text)
    val shielded = PrototypeDataResolver.resolve(spec, shield = true).root as PrototypeTextNode
    assertNotEquals(contract.text, shielded.text)
    assertEquals("{${mark}key} {key}", shielded.text)
  }
}
