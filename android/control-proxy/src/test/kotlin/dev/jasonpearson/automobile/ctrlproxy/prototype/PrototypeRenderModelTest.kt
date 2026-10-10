package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Gravity
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeRenderModelTest {
  companion object {
    @JvmStatic
    @org.junit.BeforeClass
    fun warmMapping() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun spec(root: PrototypeNode) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)

  @Test
  fun `an unstyled node has no fixed colour so the theme content colour applies`() {
    val node = mapPrototypeSpec(spec(PrototypeTextNode(text = "plain"))).root
    assertEquals(Color.Unspecified, node.style.color)
  }

  @Test
  fun `all static primitives expose roles text and tags`() {
    val nodes =
      listOf(
        PrototypeBoxNode(testTag = "box", children = emptyList()),
        PrototypeRowNode(testTag = "row", children = emptyList()),
        PrototypeColumnNode(testTag = "column", children = emptyList()),
        PrototypeTextNode(testTag = "text", text = "Hello"),
        PrototypeIconNode(testTag = "icon", name = "home"),
        PrototypeSpacerNode(testTag = "spacer"),
        PrototypeImageNode(testTag = "image", asset = PrototypeModeValue.Single("future")),
      )
    for (node in nodes) {
      val model = mapPrototypeSpec(spec(node)).root
      assertEquals(node.testTag, model.role)
      assertEquals(node.testTag, model.testTag)
      assertTrue(model.visible)
      assertNotNull(model.text)
    }
    assertEquals("Hello", mapPrototypeSpec(spec(nodes[3])).root.text)
    assertEquals("home", mapPrototypeSpec(spec(nodes[4])).root.text)
    assertNull(prototypeIcon("future_icon"))
  }

  @Test
  fun `closed contract icon names all map and unknown names remain placeholders`() {
    val input =
      checkNotNull(
          PrototypeSpecValidator.javaClass.getResourceAsStream("/prototype-spec-contract.json"),
        )
        .bufferedReader()
        .use { it.readText() }
    val names =
      Json.parseToJsonElement(input)
        .jsonObject
        .getValue("definitions")
        .jsonObject
        .getValue("iconName")
        .jsonObject
        .getValue("values")
        .jsonArray
    assertTrue(names.size > 2000)
    for ((index, name) in names.withIndex()) {
      val content = name.jsonPrimitive.content
      assertNotNull(content, prototypeIcon(content))
      // Every name loads filled; styles share the class layout, so a sample of names covers them.
      if (index % 40 != 0) continue
      for (variant in listOf("outlined", "rounded", "sharp", "twoTone")) {
        assertNotNull("$content/$variant", prototypeIcon(content, variant))
      }
    }
    assertNull(prototypeIcon("unknown"))
    assertNull(prototypeIcon("Home"))
    assertNull(prototypeIcon("home; drop"))
  }

  @Test
  fun `icon variants resolve distinct artwork and unknown variants fall back to filled`() {
    val filled = checkNotNull(prototypeIcon("timer"))
    assertSame(filled, prototypeIcon("timer", "filled"))
    assertSame(filled, prototypeIcon("timer", "unheard-of"))
    assertNotSame(filled, prototypeIcon("timer", "outlined"))
    assertNotSame(prototypeIcon("timer", "rounded"), prototypeIcon("timer", "sharp"))
    assertNotNull(prototypeIcon("bedtime"))
    assertNotNull(prototypeIcon("alarm_add", "twoTone"))
  }

  @Test
  fun `styleWhen resolves against state into the render style`() {
    val node =
      PrototypeTextNode(
        text = "text",
        style =
          PrototypeStyle(
            background = PrototypeModeValue.Single("#111111"),
            color = PrototypeModeValue.Single("#222222"),
          ),
        styleWhen =
          listOf(
            PrototypeStyleWhen(
              PrototypeCondition("selected", equals = PrototypeScalar.BooleanValue(true)),
              PrototypeStyle(background = PrototypeModeValue.Single("#2255CC")),
            ),
          ),
      )
    fun rendered(selected: Boolean) =
      mapPrototypeSpec(
          PrototypeSpec(
            "panel",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root = node,
            state = mapOf("selected" to PrototypeScalar.BooleanValue(selected)),
          ),
        )
        .root
        .style
    assertEquals(prototypeColor("#2255CC"), rendered(true).background)
    assertEquals(prototypeColor("#222222"), rendered(true).color)
    assertEquals(prototypeColor("#111111"), rendered(false).background)
  }

  @Test
  fun `unrepresentable styleWhen size is rejected with its path`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapPrototypeSpec(
          spec(
            PrototypeTextNode(
              text = "text",
              styleWhen =
                listOf(
                  PrototypeStyleWhen(
                    PrototypeCondition("k", equals = PrototypeScalar.Numeric(1.0)),
                    PrototypeStyle(width = PrototypeDimension.Dp(Double.MAX_VALUE)),
                  ),
                ),
            ),
          ),
        )
      }
    assertTrue(error.message.orEmpty().contains("root.styleWhen[0].style.width.dp"))
  }

  @Test
  fun `unrepresentable Compose size is rejected before content installation`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapPrototypeSpec(
          spec(
            PrototypeTextNode(
              text = "text",
              style = PrototypeStyle(width = PrototypeDimension.Dp(Double.MAX_VALUE)),
            ),
          ),
        )
      }
    assertTrue(error.message.orEmpty().contains("root.style.width.dp"))
  }

  @Test
  fun `unrepresentable weight and size bounds are rejected before content installation`() {
    val styles =
      mapOf(
        "weight" to PrototypeStyle(weight = Double.MAX_VALUE),
        "maxWidth" to PrototypeStyle(maxWidth = Double.MAX_VALUE),
        "minHeight" to PrototypeStyle(minHeight = Double.MAX_VALUE),
        "elevation" to PrototypeStyle(elevation = Double.MAX_VALUE),
        "aspectRatio" to PrototypeStyle(aspectRatio = Double.MAX_VALUE),
        "gradient.angle" to
          PrototypeStyle(
            gradient =
              PrototypeLinearGradient(
                Double.MAX_VALUE,
                listOf(PrototypeGradientStop("#000000"), PrototypeGradientStop("#ffffff")),
              ),
          ),
        "offset.y" to PrototypeStyle(offset = PrototypeOffset(0.0, -Double.MAX_VALUE)),
        "lineHeight" to PrototypeStyle(lineHeight = Double.MAX_VALUE),
        "letterSpacing" to PrototypeStyle(letterSpacing = -Double.MAX_VALUE),
        "cornerRadius.bottomStart" to
          PrototypeStyle(
            cornerRadius = PrototypeCornerRadius.Corners(bottomStart = Double.MAX_VALUE),
          ),
      )
    for ((key, style) in styles) {
      val error =
        assertThrows(IllegalArgumentException::class.java) {
          mapPrototypeSpec(spec(PrototypeTextNode(text = "text", style = style)))
        }
      assertTrue(error.message.orEmpty().contains("root.style.$key"))
    }
  }

  @Test
  fun `text polish and shadow colour map to their Compose values`() {
    val style =
      PrototypeStyle(
        shadowColor = PrototypeModeValue.Single("#80FF0000"),
        fontStyle = "italic",
        textDecoration = "underlineLineThrough",
        overflow = "ellipsis",
        lineHeight = 22.0,
        letterSpacing = 0.25,
        offset = PrototypeOffset(4.0, -2.0),
      )
    val mapped = mapPrototypeSpec(spec(PrototypeTextNode(text = "t", style = style))).root.style
    assertEquals(style, mapped.source)
    assertEquals(Color(0x80FF0000), mapped.shadowColor)
    assertEquals(FontStyle.Italic, mapped.fontStyle)
    assertEquals(
      TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough)),
      mapped.textDecoration,
    )
    assertEquals(TextOverflow.Ellipsis, mapped.overflow)
    val decorations =
      mapOf(
        "none" to TextDecoration.None,
        "underline" to TextDecoration.Underline,
        "lineThrough" to TextDecoration.LineThrough,
      )
    for ((wire, expected) in decorations) {
      assertEquals(
        wire,
        expected,
        mapPrototypeStyle(PrototypeStyle(textDecoration = wire)).textDecoration,
      )
    }
    assertEquals(
      TextOverflow.Visible,
      mapPrototypeStyle(PrototypeStyle(overflow = "visible")).overflow,
    )
  }

  @Test
  fun `unset text polish keeps Compose defaults and a role shadow colour resolves later`() {
    val mapped =
      mapPrototypeStyle(PrototypeStyle(shadowColor = PrototypeModeValue.Single("primary")))
    assertNull(mapped.shadowColor)
    assertEquals(FontStyle.Normal, mapped.fontStyle)
    assertEquals(TextDecoration.None, mapped.textDecoration)
    assertEquals(TextOverflow.Clip, mapped.overflow)
  }

  @Test
  fun `linear gradient line runs corner to corner along the angle`() {
    val (start, end) = prototypeLinearGradientLine(0.0, 100f, 40f)
    assertEquals(0f, start.x, 0.01f)
    assertEquals(20f, start.y, 0.01f)
    assertEquals(100f, end.x, 0.01f)
    assertEquals(20f, end.y, 0.01f)
    val (top, bottom) = prototypeLinearGradientLine(90.0, 100f, 40f)
    assertEquals(50f, top.x, 0.01f)
    assertEquals(0f, top.y, 0.01f)
    assertEquals(40f, bottom.y, 0.01f)
  }

  @Test
  fun `gradient stop positions apply only when every stop authors one`() {
    val palette = PrototypePalette(lightColorScheme(), dark = false)
    val even =
      prototypeGradientStops(
        listOf(PrototypeGradientStop("#000000", 0.2), PrototypeGradientStop("#ffffff")),
        palette,
      )
    assertEquals(listOf(Color(0xff000000), Color(0xffffffff)), even.first)
    assertNull(even.second)
    val explicit =
      prototypeGradientStops(
        listOf(PrototypeGradientStop("#000000", 0.2), PrototypeGradientStop("#ffffff", 1.0)),
        palette,
      )
    assertEquals(listOf(0.2f, 1f), explicit.second)
    val descending =
      prototypeGradientStops(
        listOf(PrototypeGradientStop("#000000", 0.8), PrototypeGradientStop("#ffffff", 0.2)),
        palette,
      )
    assertEquals(listOf(0.8f, 0.8f), descending.second)
  }

  @Test
  fun `elevation gradient and aspect ratio survive pure mapping`() {
    val style =
      PrototypeStyle(
        elevation = 4.5,
        aspectRatio = 1.5,
        gradient =
          PrototypeRadialGradient(
            listOf(PrototypeGradientStop("#000000"), PrototypeGradientStop("#ffffff")),
          ),
      )
    val node = mapPrototypeSpec(spec(PrototypeTextNode(text = "t", style = style))).root
    assertEquals(style, node.style.source)
  }

  @Test
  fun `every style property and safe area selection survive pure mapping`() {
    val style =
      PrototypeStyle(
        width = PrototypeDimension.Fill,
        height = PrototypeDimension.Dp(40.5),
        weight = 2.5,
        minWidth = 10.0,
        maxWidth = 200.5,
        minHeight = 20.0,
        maxHeight = 90.0,
        padding = PrototypePadding(1.0, 2.0, 3.0, 4.0),
        background = PrototypeModeValue.Single("#112233"),
        cornerRadius = PrototypeCornerRadius.Dp(6.0),
        border = PrototypeBorder(2.0, "#80112233"),
        alpha = 0.4,
        alignment = "bottomEnd",
        arrangement = "spaceBetween",
        spacing = 8.0,
        textSize = 18.0,
        fontWeight = 700,
        color = PrototypeModeValue.Single("#ff556677"),
        textAlign = "justify",
        maxLines = 3,
        fontFamily = PrototypeFontFamily.Named("monospace"),
      )
    val safeArea =
      PrototypeSafeAreaPadding(listOf("top", "start"), listOf("systemBars", "cutout", "ime"))
    val node =
      mapPrototypeSpec(
          spec(PrototypeTextNode(style = style, safeAreaPadding = safeArea, text = "text")),
        )
        .root
    assertEquals(style, node.style.source)
    assertEquals(safeArea, node.safeArea)
    assertEquals(Color(0xff112233), node.style.background)
    assertEquals(Color(0x80112233), node.style.borderColor)
    assertEquals(Color(0xff556677), node.style.color)
    assertEquals(Alignment.BottomEnd, node.style.alignment)
    assertEquals(Alignment.End, node.style.horizontalAlignment)
    assertEquals(Alignment.Bottom, node.style.verticalAlignment)
    assertEquals(FontWeight.Bold, node.style.fontWeight)
    assertEquals(FontFamily.Monospace, node.style.fontFamily)
    assertEquals(TextAlign.Justify, node.style.textAlign)
    assertEquals(
      PrototypeDimension.Wrap,
      mapPrototypeStyle(PrototypeStyle(width = PrototypeDimension.Wrap)).source.width,
    )
    assertEquals(
      FontFamily.SansSerif,
      mapPrototypeStyle(PrototypeStyle(fontFamily = PrototypeFontFamily.Named("sansSerif")))
        .fontFamily,
    )
    assertEquals(
      FontFamily.Serif,
      mapPrototypeStyle(PrototypeStyle(fontFamily = PrototypeFontFamily.Named("serif"))).fontFamily,
    )
    assertEquals(FontFamily.Default, mapPrototypeStyle(PrototypeStyle()).fontFamily)
    assertEquals(
      TextAlign.Center,
      mapPrototypeStyle(PrototypeStyle(textAlign = "center")).textAlign,
    )
    assertEquals(TextAlign.End, mapPrototypeStyle(PrototypeStyle(textAlign = "end")).textAlign)
  }

  @Test
  fun `visibility uses exact scalar equality and missing keys hide nodes`() {
    val root =
      PrototypeTextNode(
        text = "{name} {count} {enabled} {missing} {page} {pageCount}",
        visibleWhen = PrototypeCondition("enabled", PrototypeScalar.BooleanValue(true)),
      )
    val state =
      mapOf(
        "name" to PrototypeScalar.Text("Jason"),
        "count" to PrototypeScalar.Numeric(2.0),
        "enabled" to PrototypeScalar.BooleanValue(true),
        "page" to PrototypeScalar.Numeric(1.0),
      )
    val visible = mapPrototypeSpec(spec(root).copy(state = state)).root
    assertTrue(visible.visible)
    assertEquals("Jason 2 true {missing} {page} {pageCount}", visible.text)
    assertFalse(mapPrototypeSpec(spec(root)).root.visible)
    assertFalse(
      mapPrototypeSpec(spec(root).copy(state = state + ("enabled" to PrototypeScalar.Text("true"))))
        .root
        .visible,
    )
  }

  @Test
  fun `interpolation substitutes only well formed identifier tokens`() {
    val state =
      mapOf(
        "a" to PrototypeScalar.Text("A"),
        "b_2" to PrototypeScalar.Text("B"),
        "_x" to PrototypeScalar.Text("X"),
        "n" to PrototypeScalar.Numeric(3.0),
        "f" to PrototypeScalar.Numeric(1.5),
        "t" to PrototypeScalar.BooleanValue(true),
        "nest" to PrototypeScalar.Text("{a}"),
        "big" to PrototypeScalar.Numeric(12_345_678.0),
        "zero" to PrototypeScalar.Numeric(-0.0),
        "small" to PrototypeScalar.Numeric(0.00001),
      )
    val cases =
      mapOf(
        "" to "",
        "plain } text ] {" to "plain } text ] {",
        "{a}" to "A",
        "{a}{b_2}{_x}" to "ABX",
        "}{a}{" to "}A{",
        "{{a}}" to "{A}",
        "{a" to "{a",
        "{}" to "{}",
        "{1a}" to "{1a}",
        "{a-b}" to "{a-b}",
        "{ a }" to "{ a }",
        "{missing}" to "{missing}",
        "{n} {f} {t}" to "3 1.5 true",
        // Numbers go through the helper repeat bindings use: no exponent, no negative zero.
        "{big} {zero} {small}" to "12345678 0 0.00001",
        "{nest}" to "{a}",
        "{page}/{pageCount}" to "{page}/{pageCount}",
      )
    cases.forEach { (input, expected) ->
      assertEquals(input, expected, interpolatePrototypeText(input, state))
    }
  }

  @Test
  fun `interpolation resolves page tokens only inside a pager`() {
    val state =
      mapOf("page" to PrototypeScalar.Numeric(2.0), "pageCount" to PrototypeScalar.Numeric(5.0))
    assertEquals("2/5", interpolatePrototypeText("{page}/{pageCount}", state, inPager = true))
    assertEquals(
      "{page}/{pageCount}",
      interpolatePrototypeText("{page}/{pageCount}", state, inPager = false),
    )
  }

  @Test
  fun `placement opacity and alpha first colors map without a display`() {
    assertEquals(100, mapPrototypeSpec(spec(PrototypeSpacerNode())).opacityPercent)
    val window = PrototypeWindow(PrototypeFullscreenPlacement("#80123456"), 37)
    val model = mapPrototypeSpec(spec(PrototypeSpacerNode()).copy(window = window))
    assertEquals(37, model.request().opacityPercent)
    assertEquals(
      PrototypePlacement.Fullscreen(Color(0x80123456), PrototypeModeValue.Single("#80123456")),
      model.placement,
    )
    for (edge in listOf("top", "bottom")) {
      val sheet =
        mapPrototypePlacement(PrototypeSheetPlacement(edge, 240.0)) as PrototypePlacement.Sheet
      assertEquals(
        if (edge == "top") PrototypePlacement.Edge.TOP else PrototypePlacement.Edge.BOTTOM,
        sheet.edge,
      )
      assertEquals(240f, sheet.sizeDp)
    }
    val gravities =
      mapOf(
        "topStart" to (Gravity.TOP or Gravity.START),
        "topCenter" to (Gravity.TOP or Gravity.CENTER_HORIZONTAL),
        "topEnd" to (Gravity.TOP or Gravity.END),
        "centerStart" to (Gravity.CENTER_VERTICAL or Gravity.START),
        "center" to Gravity.CENTER,
        "centerEnd" to (Gravity.CENTER_VERTICAL or Gravity.END),
        "bottomStart" to (Gravity.BOTTOM or Gravity.START),
        "bottomCenter" to (Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL),
        "bottomEnd" to (Gravity.BOTTOM or Gravity.END),
      )
    for ((name, gravity) in gravities) {
      assertEquals(
        PrototypePlacement.Floating(gravity, -2f, 4f),
        mapPrototypePlacement(PrototypeFloatingPlacement(name, PrototypeOffset(-2.0, 4.0))),
      )
    }
  }

  @Test
  fun `spacing reserves gaps while arrangement distributes free space in both directions`() {
    val style = PrototypeStyle(arrangement = "spaceBetween", spacing = 5.0)
    val positions = IntArray(3)
    with(prototypeHorizontalArrangement(style)) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), LayoutDirection.Ltr, positions) }
    }
    assertArrayEquals(intArrayOf(0, 45, 90), positions)
    with(prototypeHorizontalArrangement(style)) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), LayoutDirection.Rtl, positions) }
    }
    assertArrayEquals(intArrayOf(90, 45, 0), positions)
    with(prototypeVerticalArrangement(PrototypeStyle(spacing = 5.0))) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), positions) }
    }
    assertArrayEquals(intArrayOf(0, 15, 30), positions)
  }

  @Test
  fun `interactive nodes retain typed configuration actions and children`() {
    val nodes =
      listOf(
        PrototypeTextFieldNode(stateKey = "name"),
        PrototypeScrollNode(child = PrototypeTextNode(text = "hidden")),
        PrototypePagerNode(id = "pager", children = listOf(PrototypeTextNode(text = "hidden"))),
        PrototypeTabBarNode(items = emptyList(), stateKey = "tab"),
        PrototypeBottomNavNode(items = emptyList(), stateKey = "tab"),
        PrototypeBottomSheetNode(
          child = PrototypeSpacerNode(),
          openWhen = PrototypeSheetCondition("open", true),
          detents = listOf(PrototypeDetent.Full),
        ),
      )
    for (node in nodes) {
      val model = mapPrototypeSpec(spec(node))
      assertEquals(node, model.root.source)
      assertEquals(prototypeDescendants(node).size, model.root.children.size)
      assertEquals(node is PrototypeTextFieldNode, model.hasTextField)
      assertEquals(model.hasTextField, model.request().hasTextField)
    }
    val actions = listOf(PrototypeEmitAction("tap"))
    val scroll =
      PrototypeScrollNode(
        axis = "horizontal",
        onTap = actions,
        child = PrototypeTextFieldNode(stateKey = "name"),
      )
    val model = mapPrototypeSpec(spec(scroll))
    assertTrue(model.request().hasTextField)
    assertEquals(actions, model.root.source?.onTap)
    assertEquals("horizontal", (model.root.source as PrototypeScrollNode).axis)
  }

  @Test
  fun `node guard accepts exact limit and rejects next node with canonical path`() {
    val limit = PrototypeSpecValidator.MAX_PROTOTYPE_NODES
    val root = PrototypeBoxNode(children = List(limit - 1) { PrototypeSpacerNode() })
    guardPrototypeTree(root)
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        guardPrototypeTree(root.copy(children = root.children + PrototypeSpacerNode()))
      }
    assertEquals("root.children[${limit - 1}]: Node limit exceeded", error.message)
  }

  @Test
  fun `depth guard accepts exact limit and rejects next child with canonical path`() {
    fun nested(depth: Int): PrototypeNode =
      if (depth == 1) PrototypeSpacerNode()
      else PrototypeBoxNode(children = listOf(nested(depth - 1)))
    guardPrototypeTree(nested(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH))
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapPrototypeSpec(spec(nested(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH + 1)))
      }
    assertEquals(
      "root${".children[0]".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH)}: Tree depth limit exceeded",
      error.message,
    )
  }

  @Test
  fun `shared valid fixtures map and round trip without model loss`() {
    val directory =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/valid") }
        .first { it.isDirectory }
    val fixtures = checkNotNull(directory.listFiles()).filter { it.extension == "json" }
    assertTrue(fixtures.isNotEmpty())
    for (file in fixtures) {
      val validated = PrototypeSpecValidator.validate(file.readText())
      assertTrue("${file.name}: $validated", validated is PrototypeSpecValidation.Success)
      val decoded = (validated as PrototypeSpecValidation.Success).spec
      val encoded = Json.encodeToString(decoded)
      val roundTrip = PrototypeSpecValidator.validate(encoded)
      assertEquals(
        "${file.name}: $roundTrip",
        decoded,
        (roundTrip as PrototypeSpecValidation.Success).spec,
      )
      mapPrototypeSpec(decoded)
    }
  }
}
