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
  fun `generated scalar, enum and array models round trip every filled field`() {
    assertRoundTrip("bounds", PrototypeBounds(-1.5, 2.5, 300.25, 400.5))
    assertRoundTrip("sheetCondition", PrototypeSheetCondition("sheetOpen", true))
    assertRoundTrip(
      "safeAreaPadding",
      PrototypeSafeAreaPadding(listOf("top", "start"), listOf("systemBars", "ime")),
    )
    assertRoundTrip("animate", PrototypeAnimate(450, "spring"))
    assertRoundTrip("stagger", PrototypeStagger(40, "center"))
    assertRoundTrip("zoomable", PrototypeZoomable(4.5))
    assertRoundTrip("radioOption", PrototypeRadioOption("small", "Small"))
    assertRoundTrip("chartRange", PrototypeChartRange(-2.5, 10.5))
    assertEquals(PrototypeAnimate(), Json.decodeFromString<PrototypeAnimate>("{}"))
    assertEquals(PrototypeStagger(0), Json.decodeFromString<PrototypeStagger>("""{"ms":0}"""))
  }

  private inline fun <reified T> assertRoundTrip(name: String, expected: T) {
    val element = fixture.getValue(name)
    assertEquals(expected, Json.decodeFromJsonElement<T>(element))
    assertEquals(element, Json.encodeToJsonElement(expected))
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
