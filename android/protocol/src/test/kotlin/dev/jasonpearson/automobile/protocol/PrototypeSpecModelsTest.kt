package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class PrototypeSpecModelsTest {
  private val fixture =
    Json.parseToJsonElement(File(fixtureDirectory(), "models.json").readText()).jsonObject

  @Test
  fun `generated leaves round trip every filled field`() {
    val offset = Json.decodeFromJsonElement<PrototypeOffset>(fixture.getValue("offset"))
    assertEquals(PrototypeOffset(-12.5, 24.25), offset)
    assertEquals(fixture["offset"], Json.encodeToJsonElement(offset))
    val padding = Json.decodeFromJsonElement<PrototypePadding>(fixture.getValue("padding"))
    assertEquals(PrototypePadding(1.5, 2.5, 3.5, 4.5), padding)
    assertEquals(fixture["padding"], Json.encodeToJsonElement(padding))
  }

  @Test
  fun `generated leaves retain strict unknown key rejection`() {
    val offset = JsonObject(fixture.getValue("offset").jsonObject + ("unknown" to JsonPrimitive(1)))
    assertThrows(SerializationException::class.java) {
      Json.decodeFromJsonElement<PrototypeOffset>(offset)
    }
    val padding =
      JsonObject(fixture.getValue("padding").jsonObject + ("unknown" to JsonPrimitive(1)))
    assertThrows(SerializationException::class.java) {
      Json.decodeFromJsonElement<PrototypePadding>(padding)
    }
  }

  @Test
  fun `optional fields retain null defaults and required fields stay required`() {
    assertEquals(PrototypePadding(), Json.decodeFromString<PrototypePadding>("{}"))
    assertEquals(
      PrototypePadding(),
      Json.decodeFromString<PrototypePadding>(
        """{"top":null,"bottom":null,"start":null,"end":null}""",
      ),
    )
    assertThrows(SerializationException::class.java) {
      Json.decodeFromString<PrototypeOffset>("""{"x":1}""")
    }
  }
}
