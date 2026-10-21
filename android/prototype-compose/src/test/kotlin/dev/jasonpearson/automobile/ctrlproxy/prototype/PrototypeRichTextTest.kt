package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRichTextTest {
  private fun spec(root: PrototypeNode) =
    PrototypeSpec("rich", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)

  @Test
  fun `span mapping resolves each state field and retains only authored actions`() {
    val actions = listOf(PrototypeEmitAction("terms"))
    val node =
      PrototypeTextNode(
        spans =
          listOf(
            PrototypeTextSpan("Hello {name}"),
            PrototypeTextSpan(" terms", onTap = actions),
          ),
        testTag = "rich",
      )
    val state = mapOf("name" to PrototypeScalar.Text("Jason"))
    val spans = checkNotNull(mapPrototypeTextSpans(node, state))
    assertEquals(listOf("Hello Jason", " terms"), spans.map { it.text })
    assertNull(spans[0].onTap)
    assertEquals(actions, spans[1].onTap)
    val mapped = mapPrototypeSpec(spec(node).copy(state = state)).root
    assertEquals("Hello Jason terms", mapped.text)
    assertEquals(spans, mapped.spans)
    assertEquals("rich", mapped.testTag)
  }

  @Test
  fun `span styles use existing colour font and combined decoration mapping`() {
    val source =
      PrototypeTextSpanStyle(
        color = PrototypeModeValue.Modes("primary", "#123456"),
        background = PrototypeModeValue.Single("secondaryContainer"),
        fontWeight = 700,
        fontStyle = "italic",
        textDecoration = "underlineLineThrough",
        textSize = 18.0,
        letterSpacing = -0.5,
        fontFamily = PrototypeFontFamily.Named("serif"),
      )
    val span =
      mapPrototypeTextSpans(
          PrototypeTextNode(spans = listOf(PrototypeTextSpan("styled", source))),
          emptyMap(),
        )!!
        .single()
    val style = span.style
    assertEquals(FontWeight(700), style.fontWeight)
    assertEquals(FontStyle.Italic, style.fontStyle)
    assertEquals(FontFamily.Serif, style.fontFamily)
    assertEquals(
      TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough)),
      style.textDecoration,
    )
    assertEquals(18.0, checkNotNull(style.source.textSize), 0.0)
    assertEquals(-0.5, checkNotNull(style.source.letterSpacing), 0.0)
    val light = PrototypePalette(lightColorScheme(primary = Color.Red), false)
    val dark = PrototypePalette(darkColorScheme(), true)
    assertEquals(Color.Red, prototypeResolveColor(light, style.color, style.source.color))
    assertEquals(
      prototypeColor("#123456"),
      prototypeResolveColor(dark, style.color, style.source.color),
    )
    assertEquals(
      light.scheme.secondaryContainer,
      prototypeResolveColor(light, style.background, style.source.background),
    )
  }

  @Test
  fun `span font assets are discovered and preserve the same fallback as node fonts`() {
    val node =
      PrototypeTextNode(
        spans =
          listOf(
            PrototypeTextSpan(
              "font",
              PrototypeTextSpanStyle(fontFamily = PrototypeFontFamily.Asset("custom")),
            ),
          ),
      )
    assertEquals(listOf("custom"), prototypeAssetReferences(node))
    val span = mapPrototypeTextSpans(node, emptyMap())!!.single()
    assertEquals("custom", span.style.fontAsset)
    assertEquals(FontFamily.Default, span.style.fontFamily)
  }

  @Test
  fun `plain text path and inherited span styles remain unspecified`() {
    val node = PrototypeTextNode(text = "Hello {name}")
    val state = mapOf("name" to PrototypeScalar.Text("Jason"))
    assertNull(mapPrototypeTextSpans(node, state))
    assertEquals("Hello Jason", mapPrototypeSpec(spec(node).copy(state = state)).root.text)
    val unstyled =
      mapPrototypeTextSpans(
          PrototypeTextNode(spans = listOf(PrototypeTextSpan("plain"))),
          emptyMap(),
        )!!
        .single()
        .style
    assertEquals(Color.Unspecified, unstyled.color)
    assertNull(unstyled.source.fontWeight)
    assertNull(unstyled.source.textDecoration)
    // Each span is scanned separately; concatenating authored fields must not create a placeholder.
    val split =
      PrototypeTextNode(spans = listOf(PrototypeTextSpan("{na"), PrototypeTextSpan("me}")))
    assertEquals("{name}", mapPrototypeSpec(spec(split).copy(state = state)).root.text)
  }

  @Test
  fun `data repeat and state substitutions compose per span with bound actions`() {
    val node =
      PrototypeTextNode(
        spans =
          listOf(
            PrototypeTextSpan(
              "{data:/prefix} {item.title} {suffix}",
              onTap =
                listOf(
                  PrototypeEmitAction("open_{item.id}"),
                  PrototypeToggleAction("liked_{item.id}"),
                ),
            ),
          ),
      )
    val root =
      PrototypeColumnNode(
        children = listOf(node),
        repeat =
          PrototypeRepeat(
            listOf(
              mapOf(
                "title" to PrototypeScalar.Text("Terms"),
                "id" to PrototypeScalar.Text("1"),
              ),
            ),
            "item",
          ),
      )
    val input =
      spec(root)
        .copy(
          data = buildJsonObject { put("prefix", "Read") },
          state = mapOf("suffix" to PrototypeScalar.Text("now")),
        )
    val mapped = mapPrototypeSpec(input).root.children.single()
    assertEquals("Read Terms now", mapped.text)
    assertEquals("Read Terms now", mapped.spans!!.single().text)
    assertEquals(
      listOf(PrototypeEmitAction("open_1"), PrototypeToggleAction("liked_1")),
      mapped.spans.single().onTap,
    )
  }

  companion object {
    @BeforeClass
    @JvmStatic
    fun warm() {
      PrototypeSpecValidator.validate("{}")
      val node = PrototypeTextNode(spans = listOf(PrototypeTextSpan("warm")))
      mapPrototypeSpec(
        PrototypeSpec("warm", PrototypeWindow(PrototypeFullscreenPlacement()), root = node),
      )
      lightColorScheme()
      darkColorScheme()
      mapPrototypeTextSpans(
        PrototypeTextNode(spans = listOf(PrototypeTextSpan("warm"))),
        emptyMap(),
      )
    }
  }
}
