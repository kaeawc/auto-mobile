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
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeSpecModelsTest {
  private val json = Json { classDiscriminator = "type" }
  private val fixture =
    Json.parseToJsonElement(File(fixtureDirectory(), "models.json").readText()).jsonObject

  @Test
  fun `upload contract models round trip every filled field`() {
    assertRoundTrip("requestUploadFile", PrototypeRequestUploadFile("hero"))
    assertRoundTrip(
      "requestUploadPart",
      PrototypeRequestUploadPart(
        "photo",
        file = PrototypeRequestUploadFile("hero"),
        filename = "photo.png",
        contentType = "image/png",
      ),
    )
    assertEquals(10 * 1024 * 1024, PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES)
    assertEquals(16, PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_PARTS)
  }

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

  companion object {
    @JvmStatic
    @BeforeAll
    fun initializeSerializationMetadata() {
      // JVM serializer metadata is lazy; initialize it outside each model's assertion budget.
      val serializers =
        listOf(
          PrototypeContainer.serializer(),
          PrototypeSelector.serializer(),
          PrototypeStyleWhen.serializer(),
          PrototypeAnchor.serializer(),
          PrototypePlacement.serializer(),
          PrototypeGradient.serializer(),
          PrototypeListItemTrailing.serializer(),
          PrototypeAppBarAction.serializer(),
          PrototypeDialogButton.serializer(),
          PrototypeScrollRefresh.serializer(),
          PrototypeBorder.serializer(),
          PrototypeGradientStop.serializer(),
          PrototypeCondition.serializer(),
          PrototypeStyle.serializer(),
          PrototypeAction.serializer(),
        )
      for (serializer in serializers) {
        val descriptor = serializer.descriptor
        for (index in 0 until descriptor.elementsCount) descriptor.getElementDescriptor(index)
      }
    }
  }

  @Test
  fun `generated container and selector references round trip`() {
    val container =
      PrototypeContainer(
        text = "Panel",
        index = 0,
        selectionStrategy = "unique",
        container = PrototypeContainer(elementId = "outer"),
      )
    assertRoundTrip("container", container)
    assertRoundTrip("selector", PrototypeSelector(testTag = "target", container = container))
  }

  @Test
  fun `generated style condition references round trip`() {
    assertRoundTrip(
      "styleWhenEntry",
      PrototypeStyleWhen(
        PrototypeCondition(key = "enabled", equals = PrototypeScalar.BooleanValue(true)),
        PrototypeStyle(color = PrototypeModeValue.Single("#112233")),
      ),
    )
  }

  @Test
  fun `generated anchor variants round trip`() {
    val offset = PrototypeOffset(-12.5, 24.25)
    assertRoundTrip<PrototypeAnchor>(
      "anchorBounds",
      PrototypeBoundsAnchor(
        PrototypeBounds(-1.5, 2.5, 300.25, 400.5),
        "top",
        offset,
      ),
    )
    assertRoundTrip<PrototypeAnchor>(
      "anchorElement",
      PrototypeElementAnchor(
        PrototypeSelector(elementId = "target"),
        "cover",
        offset,
      ),
    )
  }

  @Test
  fun `generated placement variants round trip`() {
    val modes = PrototypeModeValue.Modes("#112233", "#445566")
    assertRoundTrip<PrototypePlacement>("placementFullscreen", PrototypeFullscreenPlacement(modes))
    assertRoundTrip<PrototypePlacement>("placementSheet", PrototypeSheetPlacement("bottom", 320.0))
    assertRoundTrip<PrototypePlacement>(
      "placementFloating",
      PrototypeFloatingPlacement("center", PrototypeOffset(-12.5, 24.25)),
    )
  }

  @Test
  fun `generated gradient variants round trip`() {
    val modes = PrototypeModeValue.Modes("#112233", "#445566")
    val stops = listOf(PrototypeGradientStop("#112233", 0.0), PrototypeGradientStop(modes, 1.0))
    assertRoundTrip<PrototypeGradient>("gradientLinear", PrototypeLinearGradient(45.0, stops))
    assertRoundTrip<PrototypeGradient>("gradientRadial", PrototypeRadialGradient(stops))
  }

  @Test
  fun `generated trailing control variants round trip`() {
    assertRoundTrip<PrototypeListItemTrailing>(
      "listItemTrailingSwitch",
      PrototypeListItemSwitch("enabled"),
    )
    assertRoundTrip<PrototypeListItemTrailing>(
      "listItemTrailingCheckbox",
      PrototypeListItemCheckbox("enabled"),
    )
    assertRoundTrip<PrototypeListItemTrailing>(
      "listItemTrailingIcon",
      PrototypeListItemIcon("check"),
    )
  }

  @Test
  fun `generated app bar action references round trip`() {
    assertRoundTrip(
      "appBarAction",
      PrototypeAppBarAction("check", "Go", listOf(PrototypeEmitAction("go"))),
    )
  }

  @Test
  fun `generated dialog button references round trip`() {
    assertRoundTrip("dialogButton", PrototypeDialogButton("Go", listOf(PrototypeEmitAction("go"))))
  }

  @Test
  fun `generated refresh action references round trip`() {
    assertRoundTrip(
      "scrollRefresh",
      PrototypeScrollRefresh("enabled", listOf(PrototypeEmitAction("go"))),
    )
  }

  @Test
  fun `shared border and gradient stop fixtures round trip`() {
    val modes = PrototypeModeValue.Modes("#112233", "#445566")
    assertRoundTrip("border", PrototypeBorder(2.5, "#112233"))
    assertRoundTrip("gradientStop", PrototypeGradientStop(modes, 0.5))
  }

  private inline fun <reified T> assertRoundTrip(name: String, expected: T) {
    val element = fixture.getValue(name)
    assertEquals(expected, json.decodeFromJsonElement<T>(element))
    assertEquals(element, json.encodeToJsonElement(expected))
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
