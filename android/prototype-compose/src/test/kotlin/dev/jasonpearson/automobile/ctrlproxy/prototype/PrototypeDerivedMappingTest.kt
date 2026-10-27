package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

internal class FakePrototypeValueFormatter : PrototypeValueFormatter {
  override fun format(entry: PrototypeDerivedEntry, input: JsonElement?): String =
    "formatted:${(input as? JsonPrimitive)?.content.orEmpty()}"
}

class PrototypeDerivedMappingTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      PrototypeDerivedMappingTest().`state and data changes update late text`()
      PrototypeDerivedMappingTest().`derived row keys and emit names are checked after formatting`()
      PrototypeDerivedMappingTest()
        .`rich spans and component placeholders bind through the same text traversal`()
    }
  }

  private val formatter = FakePrototypeValueFormatter()

  private fun entry(source: String) =
    PrototypeDerivedEntry(
      Json.parseToJsonElement(source).jsonObject,
      Json.parseToJsonElement("""{"number":{}}""").jsonObject,
    )

  @Test
  fun `checked rows reuse projections until root data or environment changes`() {
    var calls = 0
    val cache =
      PrototypeCheckedNodeCache(
        PrototypeValueFormatter { _, _ ->
          calls++
          "7"
        },
      )
    val root =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeTextFieldNode(
              stateKey = "input",
              checks = listOf(PrototypeCheck.Required("Required")),
            ),
          ),
        repeat =
          PrototypeRepeat(
            listOf(emptyMap()),
            "row",
            derive = mapOf("price" to entry("""{"value":7}""")),
          ),
      )
    var spec = PrototypeSpec("cache", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)
    val first = cache.nodes(spec)
    assertEquals(1, calls)
    assertSame(first, cache.nodes(spec.copy(state = mapOf("input" to PrototypeScalar.Text("new")))))
    assertEquals(1, calls)
    spec = spec.copy(data = buildJsonObject { put("changed", true) })
    cache.nodes(spec)
    assertEquals(2, calls)
    spec = spec.copy(root = root.copy(children = root.children.toList()))
    cache.nodes(spec)
    assertEquals(3, calls)
    val original = java.util.Locale.getDefault()
    try {
      java.util.Locale.setDefault(
        if (original == java.util.Locale.FRANCE) java.util.Locale.US else java.util.Locale.FRANCE,
      )
      cache.nodes(spec)
      assertEquals(4, calls)
      val zone = java.util.TimeZone.getDefault()
      try {
        java.util.TimeZone.setDefault(
          java.util.TimeZone.getTimeZone(
            if (zone.id == "Pacific/Honolulu") "UTC" else "Pacific/Honolulu",
          ),
        )
        cache.nodes(spec)
        assertEquals(5, calls)
      } finally {
        java.util.TimeZone.setDefault(zone)
      }
    } finally {
      java.util.Locale.setDefault(original)
    }
  }

  @Test
  fun `state and data changes update late text`() {
    fun mapped(value: Double, data: Int): PrototypeRenderNode =
      PrototypeNodeMapping(
          state = mapOf("amount" to PrototypeScalar.Numeric(value)),
          pages = emptyMap(),
          data = buildJsonObject { put("count", data) },
          derive =
            mapOf(
              "price" to entry("""{"state":"amount"}"""),
              "count" to entry("""{"data":"/count"}"""),
            ),
          formatter = formatter,
        )
        .map(PrototypeTextNode(text = "{derived:price} {derived:count}"), "root")
    assertEquals("formatted:12 formatted:3", mapped(12.0, 3).text)
    assertEquals("formatted:13 formatted:4", mapped(13.0, 4).text)
  }

  @Test
  fun `rich spans and component placeholders bind through the same text traversal`() {
    fun map(node: PrototypeNode) =
      PrototypeNodeMapping(
          emptyMap(),
          emptyMap(),
          derive = mapOf("x" to entry("""{"value":7}""")),
          formatter = formatter,
        )
        .map(node, "root")
    val rich = map(PrototypeTextNode(spans = listOf(PrototypeTextSpan(text = "{derived:x}"))))
    assertEquals("formatted:7", rich.spans!!.single().text)
    val field = map(PrototypeSearchBarNode(stateKey = "input", placeholder = "{derived:x}"))
    assertEquals("formatted:7", (field.source as PrototypeSearchBarNode).placeholder)
  }

  @Test
  fun `repeat derive projects original row before binding`() {
    val node =
      PrototypeColumnNode(
        children = listOf(PrototypeTextNode(text = "{row.price}")),
        repeat =
          PrototypeRepeat(
            listOf(mapOf("amount" to PrototypeScalar.Numeric(12.0))),
            "row",
            derive = mapOf("price" to entry("""{"item":"amount"}""")),
          ),
      )
    val child =
      prototypeChildEntries(node, "root", formatter = formatter).single().node as PrototypeTextNode
    assertEquals("formatted:12", child.text)
  }

  @Test
  fun `derived row keys and emit names are checked after formatting`() {
    val repeat =
      PrototypeRepeat(
        listOf(emptyMap(), emptyMap()),
        "row",
        key = "price",
        derive = mapOf("price" to entry("""{"value":7}""")),
      )
    val node =
      PrototypeColumnNode(
        children = listOf(PrototypeTextNode(text = "{row.price}")),
        repeat = repeat,
      )
    assertThrows(IllegalArgumentException::class.java) {
      prototypeChildEntries(node, "root", formatter = formatter)
    }
    val emitting =
      node.copy(
        repeat = repeat.copy(items = listOf(emptyMap()), key = null),
        children =
          listOf(
            PrototypeButtonNode(
              label = "Go",
              onTap = listOf(PrototypeEmitAction(name = "{row.price}")),
            ),
          ),
      )
    assertThrows(IllegalArgumentException::class.java) {
      prototypeChildEntries(emitting, "root", formatter = PrototypeValueFormatter { _, _ -> "" })
    }
  }

  @Test
  fun `derived substitution is bounded single pass and unknown names stay literal`() {
    val state =
      mapOf(
        "derived:x" to PrototypeScalar.Text("{derived:y}"),
        "derived:y" to PrototypeScalar.Text("wrong"),
      )
    assertEquals(
      "{derived:y} {derived:unknown}",
      interpolatePrototypeText("{derived:x} {derived:unknown}", state),
    )
    val huge = "x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH + 1)
    assertEquals(
      "{derived:x}",
      interpolatePrototypeText("{derived:x}", mapOf("derived:x" to PrototypeScalar.Text(huge))),
    )
  }

  @Test
  fun `strict calendar parsing and fixed relative thresholds`() {
    assertEquals(1767571200000L, PrototypeFormatTime.epoch(JsonPrimitive("2026-01-05")))
    assertEquals(
      1767614400000L,
      PrototypeFormatTime.epoch(JsonPrimitive("2026-01-05T14:00:00+02:00")),
    )
    for (invalid in
      listOf(
        "2026-02-30",
        "2026-01-05T12:00:00",
        "2026-01-05T12:00:00+25:00",
        "2026-01-05T24:00:00Z",
      )) assertNull(
      PrototypeFormatTime.epoch(JsonPrimitive(invalid)),
    )
    assertNull(PrototypeFormatTime.epoch(JsonPrimitive(1.5)))
    assertEquals(2592000000L to "month", PrototypeFormatTime.relativeUnit(-31535999999L))
    assertEquals(31536000000L to "year", PrototypeFormatTime.relativeUnit(31536000000L))
  }
}
