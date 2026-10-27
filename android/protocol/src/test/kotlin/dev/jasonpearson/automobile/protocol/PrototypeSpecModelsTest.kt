package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeSpecModelsTest {
  private val json = Json { classDiscriminator = "type" }
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
          PrototypeItem.serializer(),
          PrototypeAction.serializer(),
          PrototypeNode.serializer(),
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

  @Test
  fun `generated items retain mode and string constructors`() {
    assertRoundTrip(
      "item",
      PrototypeItem(
        label = "Home",
        icon = "home",
        image = PrototypeModeValue.Modes("home-light", "home-dark"),
      ),
    )
    assertRoundTrip(
      "itemString",
      PrototypeItem(label = "Search", icon = "search", image = "search-image"),
    )
  }

  @Test
  fun `generated condition round trips every field and recursive branches`() {
    val enabled = PrototypeCondition(key = "enabled", equals = PrototypeScalar.BooleanValue(true))
    // An all-fields wire value exercises serialization; semantic conditions select one branch.
    assertRoundTrip(
      "conditionFilled",
      PrototypeCondition(
        key = "enabled",
        equals = PrototypeScalar.BooleanValue(true),
        notEquals = PrototypeScalar.BooleanValue(false),
        gt = 1.0,
        lt = 10.0,
        empty = false,
        all = listOf(enabled),
        any = listOf(enabled),
        not = PrototypeCondition(key = "enabled", equals = PrototypeScalar.BooleanValue(false)),
        data = "/items",
        valid = PrototypeValidityKeys.Multiple(listOf("name", "email")),
        platform = "/os",
        contains = PrototypeScalar.Text("a"),
        startsWith = PrototypeScalar.Text("b"),
        lengthGt = 1,
        lengthLt = 9,
      ),
    )
    assertRoundTrip(
      "condition",
      PrototypeCondition(
        all =
          listOf(
            enabled,
            PrototypeCondition(
              any =
                listOf(
                  PrototypeCondition(key = "count", gt = 1.0),
                  PrototypeCondition(key = "count", lt = 10.0),
                ),
            ),
            PrototypeCondition(
              not = PrototypeCondition(key = "name", notEquals = PrototypeScalar.Text("hidden")),
            ),
            PrototypeCondition(data = "/items", empty = true),
            PrototypeCondition(valid = PrototypeValidityKeys.Multiple(listOf("name", "email"))),
            PrototypeCondition(platform = "/os", equals = PrototypeScalar.Text("android")),
          ),
      ),
    )
  }

  @Test
  fun `generated style round trips every field including nested values`() =
    assertRoundTrip("style", fullStyle())

  private fun fullStyle(): PrototypeStyle {
    val modes = PrototypeModeValue.Modes("#112233", "#445566")
    return PrototypeStyle(
        width = PrototypeDimension.Dp(240.0),
        height = PrototypeDimension.Wrap,
        weight = 1.0,
        minWidth = 10.0,
        maxWidth = 300.0,
        minHeight = 20.0,
        maxHeight = 400.0,
        padding = PrototypePadding(top = 1.5, bottom = 2.5, start = 3.5, end = 4.5),
        background = PrototypeModeValue.Single("#112233"),
        cornerRadius =
          PrototypeCornerRadius.Corners(
            topStart = 1.0,
            topEnd = 2.0,
            bottomStart = 3.0,
            bottomEnd = 4.0,
          ),
        border = PrototypeBorder(width = 2.5, color = "#112233"),
        elevation = 2.0,
        shadowColor = modes,
        gradient =
          PrototypeLinearGradient(
            angle = 45.0,
            stops =
              listOf(
                PrototypeGradientStop(color = "#112233", position = 0.0),
                PrototypeGradientStop(color = modes, position = 1.0),
              ),
          ),
        aspectRatio = 1.5,
        offset = PrototypeOffset(x = -12.5, y = 24.25),
        alpha = 0.8,
        pressScale = 0.9,
        shimmer = true,
        alignment = "center",
        arrangement = "spaceBetween",
        spacing = 4.0,
        runSpacing = 5.0,
        textSize = 16.0,
        fontWeight = 500,
        color = PrototypeModeValue.Single("#112233"),
        textAlign = "start",
        maxLines = 2,
        lineHeight = 22.0,
        letterSpacing = 0.5,
        textDecoration = "underline",
        fontStyle = "italic",
        overflow = "ellipsis",
        fontFamily = PrototypeFontFamily.Asset("body-font"),
        textStyle = "bodyLarge",
        scale = 1.2,
        rotation = 15.0,
        shader = PrototypeShader("effect", mapOf("strength" to 1.0)),
        cornerStyle = "continuous",
        effects = listOf(buildJsonObject { put("type", "noise") }),
      )
  }

  @Test
  fun `generated node fixtures retain variant classes and round trip`() {
    for ((name, element) in fixture.filterKeys { it.startsWith("node") }) {
      val value = PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeNode>(element)
      val tag = element.jsonObject.getValue("type").jsonPrimitive.content
      assertEquals(
        "Prototype" + tag.replaceFirstChar { it.uppercaseChar() } + "Node",
        value.javaClass.simpleName,
        name,
      )
      // Fixtures omit optional values equal to their defaults, preserving wire equality.
      val encoded = PrototypeSpecValidator.json.encodeToJsonElement<PrototypeNode>(value)
      assertEquals(
        value,
        PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeNode>(encoded),
        name,
      )
      assertEquals(canonical(element), canonical(encoded), name)
    }
  }

  @Test
  fun `generated action fixtures retain variant classes and round trip`() {
    for ((name, element) in fixture.filterKeys { it.startsWith("action") }) {
      val value = PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeAction>(element)
      val tag = element.jsonObject.getValue("type").jsonPrimitive.content
      assertEquals(
        "Prototype" + tag.replaceFirstChar { it.uppercaseChar() } + "Action",
        value.javaClass.simpleName,
        name,
      )
      val encoded = PrototypeSpecValidator.json.encodeToJsonElement<PrototypeAction>(value)
      assertEquals(canonical(element), canonical(encoded), name)
      assertEquals(
        value,
        PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeAction>(encoded),
        name,
      )
    }
  }

  /** Double fields encode as `1.0`; compare numbers by value so fixtures may write `1`. */
  private fun canonical(element: JsonElement): JsonElement =
    when (element) {
      is JsonObject -> JsonObject(element.mapValues { canonical(it.value) })
      is JsonArray -> JsonArray(element.map(::canonical))
      is JsonPrimitive ->
        element.takeIf { !it.isString }?.doubleOrNull?.let(::JsonPrimitive) ?: element
    }

  private inline fun <reified T> assertRoundTrip(name: String, expected: T) {
    val element = fixture.getValue(name)
    assertEquals(expected, json.decodeFromJsonElement<T>(element))
    assertEquals(canonical(element), canonical(json.encodeToJsonElement(expected)))
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
