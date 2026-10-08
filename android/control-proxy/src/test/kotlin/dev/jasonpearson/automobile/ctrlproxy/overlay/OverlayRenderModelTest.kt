package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.Gravity
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OverlayRenderModelTest {
  companion object {
    @JvmStatic
    @org.junit.BeforeClass
    fun warmMapping() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private fun spec(root: OverlayNode) =
    OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), root = root)

  @Test
  fun `an unstyled node has no fixed colour so the theme content colour applies`() {
    val node = mapOverlaySpec(spec(OverlayTextNode(text = "plain"))).root
    assertEquals(Color.Unspecified, node.style.color)
  }

  @Test
  fun `all static primitives expose roles text and tags`() {
    val nodes =
      listOf(
        OverlayBoxNode(testTag = "box", children = emptyList()),
        OverlayRowNode(testTag = "row", children = emptyList()),
        OverlayColumnNode(testTag = "column", children = emptyList()),
        OverlayTextNode(testTag = "text", text = "Hello"),
        OverlayIconNode(testTag = "icon", name = "home"),
        OverlaySpacerNode(testTag = "spacer"),
        OverlayImageNode(testTag = "image", asset = "future"),
      )
    for (node in nodes) {
      val model = mapOverlaySpec(spec(node)).root
      assertEquals(node.testTag, model.role)
      assertEquals(node.testTag, model.testTag)
      assertTrue(model.visible)
      assertNotNull(model.text)
    }
    assertEquals("Hello", mapOverlaySpec(spec(nodes[3])).root.text)
    assertEquals("home", mapOverlaySpec(spec(nodes[4])).root.text)
    assertNull(overlayIcon("future_icon"))
  }

  @Test
  fun `closed contract icon names all map and unknown names remain placeholders`() {
    val input =
      checkNotNull(
          OverlaySpecValidator.javaClass.getResourceAsStream("/overlay-spec-contract.json")
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
      assertNotNull(content, overlayIcon(content))
      // Every name loads filled; styles share the class layout, so a sample of names covers them.
      if (index % 40 != 0) continue
      for (variant in listOf("outlined", "rounded", "sharp", "twoTone")) {
        assertNotNull("$content/$variant", overlayIcon(content, variant))
      }
    }
    assertNull(overlayIcon("unknown"))
    assertNull(overlayIcon("Home"))
    assertNull(overlayIcon("home; drop"))
  }

  @Test
  fun `icon variants resolve distinct artwork and unknown variants fall back to filled`() {
    val filled = checkNotNull(overlayIcon("timer"))
    assertSame(filled, overlayIcon("timer", "filled"))
    assertSame(filled, overlayIcon("timer", "unheard-of"))
    assertNotSame(filled, overlayIcon("timer", "outlined"))
    assertNotSame(overlayIcon("timer", "rounded"), overlayIcon("timer", "sharp"))
    assertNotNull(overlayIcon("bedtime"))
    assertNotNull(overlayIcon("alarm_add", "twoTone"))
  }

  @Test
  fun `styleWhen resolves against state into the render style`() {
    val node =
      OverlayTextNode(
        text = "text",
        style = OverlayStyle(background = "#111111", color = "#222222"),
        styleWhen =
          listOf(
            OverlayStyleWhen(
              OverlayCondition("selected", equals = OverlayScalar.BooleanValue(true)),
              OverlayStyle(background = "#2255CC"),
            )
          ),
      )
    fun rendered(selected: Boolean) =
      mapOverlaySpec(
          OverlaySpec(
            "panel",
            OverlayWindow(OverlayFullscreenPlacement()),
            root = node,
            state = mapOf("selected" to OverlayScalar.BooleanValue(selected)),
          )
        )
        .root
        .style
    assertEquals(overlayColor("#2255CC"), rendered(true).background)
    assertEquals(overlayColor("#222222"), rendered(true).color)
    assertEquals(overlayColor("#111111"), rendered(false).background)
  }

  @Test
  fun `unrepresentable styleWhen size is rejected with its path`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapOverlaySpec(
          spec(
            OverlayTextNode(
              text = "text",
              styleWhen =
                listOf(
                  OverlayStyleWhen(
                    OverlayCondition("k", equals = OverlayScalar.Numeric(1.0)),
                    OverlayStyle(width = OverlayDimension.Dp(Double.MAX_VALUE)),
                  )
                ),
            )
          )
        )
      }
    assertTrue(error.message.orEmpty().contains("root.styleWhen[0].style.width.dp"))
  }

  @Test
  fun `unrepresentable Compose size is rejected before content installation`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapOverlaySpec(
          spec(
            OverlayTextNode(
              text = "text",
              style = OverlayStyle(width = OverlayDimension.Dp(Double.MAX_VALUE)),
            )
          )
        )
      }
    assertTrue(error.message.orEmpty().contains("root.style.width.dp"))
  }

  @Test
  fun `unrepresentable weight and size bounds are rejected before content installation`() {
    val styles =
      mapOf(
        "weight" to OverlayStyle(weight = Double.MAX_VALUE),
        "maxWidth" to OverlayStyle(maxWidth = Double.MAX_VALUE),
        "minHeight" to OverlayStyle(minHeight = Double.MAX_VALUE),
        "elevation" to OverlayStyle(elevation = Double.MAX_VALUE),
        "aspectRatio" to OverlayStyle(aspectRatio = Double.MAX_VALUE),
        "gradient.angle" to
          OverlayStyle(
            gradient =
              OverlayLinearGradient(
                Double.MAX_VALUE,
                listOf(OverlayGradientStop("#000000"), OverlayGradientStop("#ffffff")),
              )
          ),
      )
    for ((key, style) in styles) {
      val error =
        assertThrows(IllegalArgumentException::class.java) {
          mapOverlaySpec(spec(OverlayTextNode(text = "text", style = style)))
        }
      assertTrue(error.message.orEmpty().contains("root.style.$key"))
    }
  }

  @Test
  fun `linear gradient line runs corner to corner along the angle`() {
    val (start, end) = overlayLinearGradientLine(0.0, 100f, 40f)
    assertEquals(0f, start.x, 0.01f)
    assertEquals(20f, start.y, 0.01f)
    assertEquals(100f, end.x, 0.01f)
    assertEquals(20f, end.y, 0.01f)
    val (top, bottom) = overlayLinearGradientLine(90.0, 100f, 40f)
    assertEquals(50f, top.x, 0.01f)
    assertEquals(0f, top.y, 0.01f)
    assertEquals(40f, bottom.y, 0.01f)
  }

  @Test
  fun `gradient stop positions apply only when every stop authors one`() {
    val even =
      overlayGradientStops(
        listOf(OverlayGradientStop("#000000", 0.2), OverlayGradientStop("#ffffff"))
      )
    assertEquals(listOf(Color(0xff000000), Color(0xffffffff)), even.first)
    assertNull(even.second)
    val explicit =
      overlayGradientStops(
        listOf(OverlayGradientStop("#000000", 0.2), OverlayGradientStop("#ffffff", 1.0))
      )
    assertEquals(listOf(0.2f, 1f), explicit.second)
  }

  @Test
  fun `elevation gradient and aspect ratio survive pure mapping`() {
    val style =
      OverlayStyle(
        elevation = 4.5,
        aspectRatio = 1.5,
        gradient =
          OverlayRadialGradient(
            listOf(OverlayGradientStop("#000000"), OverlayGradientStop("#ffffff"))
          ),
      )
    val node = mapOverlaySpec(spec(OverlayTextNode(text = "t", style = style))).root
    assertEquals(style, node.style.source)
  }

  @Test
  fun `every style property and safe area selection survive pure mapping`() {
    val style =
      OverlayStyle(
        width = OverlayDimension.Fill,
        height = OverlayDimension.Dp(40.5),
        weight = 2.5,
        minWidth = 10.0,
        maxWidth = 200.5,
        minHeight = 20.0,
        maxHeight = 90.0,
        padding = OverlayPadding(1.0, 2.0, 3.0, 4.0),
        background = "#112233",
        cornerRadius = OverlayCornerRadius.Dp(6.0),
        border = OverlayBorder(2.0, "#80112233"),
        alpha = 0.4,
        alignment = "bottomEnd",
        arrangement = "spaceBetween",
        spacing = 8.0,
        textSize = 18.0,
        fontWeight = 700,
        color = "#ff556677",
        textAlign = "justify",
        maxLines = 3,
        fontFamily = "monospace",
      )
    val safeArea =
      OverlaySafeAreaPadding(listOf("top", "start"), listOf("systemBars", "cutout", "ime"))
    val node =
      mapOverlaySpec(
          spec(OverlayTextNode(style = style, safeAreaPadding = safeArea, text = "text"))
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
      OverlayDimension.Wrap,
      mapOverlayStyle(OverlayStyle(width = OverlayDimension.Wrap)).source.width,
    )
    assertEquals(
      FontFamily.SansSerif,
      mapOverlayStyle(OverlayStyle(fontFamily = "sansSerif")).fontFamily,
    )
    assertEquals(FontFamily.Serif, mapOverlayStyle(OverlayStyle(fontFamily = "serif")).fontFamily)
    assertEquals(FontFamily.Default, mapOverlayStyle(OverlayStyle()).fontFamily)
    assertEquals(TextAlign.Center, mapOverlayStyle(OverlayStyle(textAlign = "center")).textAlign)
    assertEquals(TextAlign.End, mapOverlayStyle(OverlayStyle(textAlign = "end")).textAlign)
  }

  @Test
  fun `visibility uses exact scalar equality and missing keys hide nodes`() {
    val root =
      OverlayTextNode(
        text = "{name} {count} {enabled} {missing} {page} {pageCount}",
        visibleWhen = OverlayCondition("enabled", OverlayScalar.BooleanValue(true)),
      )
    val state =
      mapOf(
        "name" to OverlayScalar.Text("Jason"),
        "count" to OverlayScalar.Numeric(2.0),
        "enabled" to OverlayScalar.BooleanValue(true),
        "page" to OverlayScalar.Numeric(1.0),
      )
    val visible = mapOverlaySpec(spec(root).copy(state = state)).root
    assertTrue(visible.visible)
    assertEquals("Jason 2 true {missing} {page} {pageCount}", visible.text)
    assertFalse(mapOverlaySpec(spec(root)).root.visible)
    assertFalse(
      mapOverlaySpec(spec(root).copy(state = state + ("enabled" to OverlayScalar.Text("true"))))
        .root
        .visible
    )
  }

  @Test
  fun `interpolation substitutes only well formed identifier tokens`() {
    val state =
      mapOf(
        "a" to OverlayScalar.Text("A"),
        "b_2" to OverlayScalar.Text("B"),
        "_x" to OverlayScalar.Text("X"),
        "n" to OverlayScalar.Numeric(3.0),
        "f" to OverlayScalar.Numeric(1.5),
        "t" to OverlayScalar.BooleanValue(true),
        "nest" to OverlayScalar.Text("{a}"),
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
        "{nest}" to "{a}",
        "{page}/{pageCount}" to "{page}/{pageCount}",
      )
    cases.forEach { (input, expected) ->
      assertEquals(input, expected, interpolateOverlayText(input, state))
    }
  }

  @Test
  fun `interpolation resolves page tokens only inside a pager`() {
    val state =
      mapOf("page" to OverlayScalar.Numeric(2.0), "pageCount" to OverlayScalar.Numeric(5.0))
    assertEquals("2/5", interpolateOverlayText("{page}/{pageCount}", state, inPager = true))
    assertEquals(
      "{page}/{pageCount}",
      interpolateOverlayText("{page}/{pageCount}", state, inPager = false),
    )
  }

  @Test
  fun `placement opacity and alpha first colors map without a display`() {
    assertEquals(100, mapOverlaySpec(spec(OverlaySpacerNode())).opacityPercent)
    val window = OverlayWindow(OverlayFullscreenPlacement("#80123456"), 37)
    val model = mapOverlaySpec(spec(OverlaySpacerNode()).copy(window = window))
    assertEquals(37, model.request().opacityPercent)
    assertEquals(OverlayPlacement.Fullscreen(Color(0x80123456)), model.placement)
    for (edge in listOf("top", "bottom")) {
      val sheet = mapOverlayPlacement(OverlaySheetPlacement(edge, 240.0)) as OverlayPlacement.Sheet
      assertEquals(
        if (edge == "top") OverlayPlacement.Edge.TOP else OverlayPlacement.Edge.BOTTOM,
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
        OverlayPlacement.Floating(gravity, -2f, 4f),
        mapOverlayPlacement(OverlayFloatingPlacement(name, OverlayOffset(-2.0, 4.0))),
      )
    }
  }

  @Test
  fun `spacing reserves gaps while arrangement distributes free space in both directions`() {
    val style = OverlayStyle(arrangement = "spaceBetween", spacing = 5.0)
    val positions = IntArray(3)
    with(overlayHorizontalArrangement(style)) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), LayoutDirection.Ltr, positions) }
    }
    assertArrayEquals(intArrayOf(0, 45, 90), positions)
    with(overlayHorizontalArrangement(style)) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), LayoutDirection.Rtl, positions) }
    }
    assertArrayEquals(intArrayOf(90, 45, 0), positions)
    with(overlayVerticalArrangement(OverlayStyle(spacing = 5.0))) {
      with(Density(1f)) { arrange(100, intArrayOf(10, 10, 10), positions) }
    }
    assertArrayEquals(intArrayOf(0, 15, 30), positions)
  }

  @Test
  fun `interactive nodes retain typed configuration actions and children`() {
    val nodes =
      listOf(
        OverlayTextFieldNode(stateKey = "name"),
        OverlayScrollNode(child = OverlayTextNode(text = "hidden")),
        OverlayPagerNode(id = "pager", children = listOf(OverlayTextNode(text = "hidden"))),
        OverlayTabBarNode(items = emptyList(), stateKey = "tab"),
        OverlayBottomNavNode(items = emptyList(), stateKey = "tab"),
        OverlayBottomSheetNode(
          child = OverlaySpacerNode(),
          openWhen = OverlaySheetCondition("open", true),
          detents = listOf(OverlayDetent.Full),
        ),
      )
    for (node in nodes) {
      val model = mapOverlaySpec(spec(node))
      assertEquals(node, model.root.source)
      assertEquals(overlayDescendants(node).size, model.root.children.size)
      assertEquals(node is OverlayTextFieldNode, model.hasTextField)
      assertEquals(model.hasTextField, model.request().hasTextField)
    }
    val actions = listOf(OverlayEmitAction("tap"))
    val scroll =
      OverlayScrollNode(
        axis = "horizontal",
        onTap = actions,
        child = OverlayTextFieldNode(stateKey = "name"),
      )
    val model = mapOverlaySpec(spec(scroll))
    assertTrue(model.request().hasTextField)
    assertEquals(actions, model.root.source?.onTap)
    assertEquals("horizontal", (model.root.source as OverlayScrollNode).axis)
  }

  @Test
  fun `node guard accepts exact limit and rejects next node with canonical path`() {
    val limit = OverlaySpecValidator.MAX_OVERLAY_NODES
    val root = OverlayBoxNode(children = List(limit - 1) { OverlaySpacerNode() })
    guardOverlayTree(root)
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        guardOverlayTree(root.copy(children = root.children + OverlaySpacerNode()))
      }
    assertEquals("root.children[${limit - 1}]: Node limit exceeded", error.message)
  }

  @Test
  fun `depth guard accepts exact limit and rejects next child with canonical path`() {
    fun nested(depth: Int): OverlayNode =
      if (depth == 1) OverlaySpacerNode() else OverlayBoxNode(children = listOf(nested(depth - 1)))
    guardOverlayTree(nested(OverlaySpecValidator.MAX_OVERLAY_DEPTH))
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        mapOverlaySpec(spec(nested(OverlaySpecValidator.MAX_OVERLAY_DEPTH + 1)))
      }
    assertEquals(
      "root${".children[0]".repeat(OverlaySpecValidator.MAX_OVERLAY_DEPTH)}: Tree depth limit exceeded",
      error.message,
    )
  }

  @Test
  fun `shared valid fixtures map and round trip without model loss`() {
    val directory =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/overlay-spec/valid") }
        .first { it.isDirectory }
    val fixtures = checkNotNull(directory.listFiles()).filter { it.extension == "json" }
    assertTrue(fixtures.isNotEmpty())
    for (file in fixtures) {
      val validated = OverlaySpecValidator.validate(file.readText())
      assertTrue("${file.name}: $validated", validated is OverlaySpecValidation.Success)
      val decoded = (validated as OverlaySpecValidation.Success).spec
      val encoded = Json.encodeToString(decoded)
      val roundTrip = OverlaySpecValidator.validate(encoded)
      assertEquals(
        "${file.name}: $roundTrip",
        decoded,
        (roundTrip as OverlaySpecValidation.Success).spec,
      )
      mapOverlaySpec(decoded)
    }
  }
}
