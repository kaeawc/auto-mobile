package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

private val specJson = Json { ignoreUnknownKeys = false }

class PrototypeDerivedCollectionsMappingTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeDerivedCollectionsMappingTest()
        .`filter keeps keyed identities and unrelated render nodes`()
    }
  }

  private fun spec(): PrototypeSpec {
    val input =
      """{
      "id":"catalog","window":{"placement":{"type":"fullscreen"}},
      "state":{"query":""},
      "data":{"rows":[{"id":"a","name":"Alpha","amount":2},{"id":"b","name":"Beta","amount":3}]},
      "derive":{
        "rows":{"collection":{"of":{"data":"/rows"},"where":[{"field":"name","op":"contains","value":{"state":"query"}}]}},
        "total":{"collection":{"of":{"data":"/rows"}},"reduce":{"op":"sum","field":"amount"},"format":{"number":{}}}
      },
      "root":{"type":"column","children":[
        {"type":"searchBar","stateKey":"query"},
        {"type":"text","text":"Static"},
        {"type":"text","text":"{derived:total}"},
        {"type":"column","repeat":{"items":{"derived":"rows"},"as":"row","key":"id"},
          "children":[{"type":"text","text":"{row.name}"}]}
      ]}
    }"""
    return specJson.decodeFromString(PrototypeSpec.serializer(), input)
  }

  @Test
  fun `filter keeps keyed identities and unrelated render nodes`() {
    val source = spec()
    val mapper = PrototypeRenderMapper(FakePrototypeValueFormatter())
    val first = mapper.map(source, emptyMap()).root
    val filtered =
      mapper
        .map(source.copy(state = mapOf("query" to PrototypeScalar.Text("alp"))), emptyMap())
        .root
    assertSame(first.children[1], filtered.children[1])
    assertSame(first.children[2], filtered.children[2])
    assertEquals("formatted:5.0", filtered.children[2].text)
    assertEquals(listOf("Alpha"), filtered.children[3].children.map { it.text })
    assertSame(first.children[3].children[0], filtered.children[3].children[0])
    val restored = mapper.map(source, emptyMap()).root
    assertEquals(listOf("Alpha", "Beta"), restored.children[3].children.map { it.text })
    assertEquals(
      first.children[3].children.map { it.identity },
      restored.children[3].children.map { it.identity },
    )
    assertSame(filtered.children[1], restored.children[1])
  }

  @Test
  fun `only input dependent entries are recomputed`() {
    val recomputed = mutableListOf<String>()
    val cache = PrototypeDerivedValuesCache(PrototypeDeriveObserver { recomputed += it })
    val source = spec()
    val initial = cache.evaluate(source)
    assertEquals(listOf("rows", "total"), recomputed)
    recomputed.clear()
    val filtered =
      cache.evaluate(source.copy(state = mapOf("query" to PrototypeScalar.Text("beta"))))
    assertEquals(listOf("rows"), recomputed)
    assertSame(initial["total"], filtered["total"])
    recomputed.clear()
    val unrelated =
      cache.evaluate(
        source.copy(
          state =
            mapOf("query" to PrototypeScalar.Text("beta"), "other" to PrototypeScalar.Numeric(1.0)),
        ),
      )
    assertTrue(recomputed.isEmpty())
    assertSame(filtered["rows"], unrelated["rows"])
  }

  @Test
  fun `large catalog search keeps unrelated nodes and uses the bound query`() {
    val source = spec()
    val rows =
      JsonArray(
        (0 until 300).map {
          buildJsonObject {
            put("id", "row$it")
            put("name", "Product $it")
            put("amount", it)
          }
        },
      )
    val catalog =
      source.copy(
        data = buildJsonObject { put("rows", rows) },
        state = mapOf("query" to PrototypeScalar.Text("Product 29")),
      )
    val mapper = PrototypeRenderMapper(FakePrototypeValueFormatter())
    val first = mapper.map(catalog, emptyMap()).root
    val next =
      mapper
        .map(
          catalog.copy(state = mapOf("query" to PrototypeScalar.Text("Product 299"))),
          emptyMap(),
        )
        .root
    assertEquals(11, first.children[3].children.size)
    assertEquals("Product 299", next.children[3].children.single().text)
    assertSame(first.children[1], next.children[1])
    assertSame(first.children[2], next.children[2])
    assertSame(first.children[3].children.last(), next.children[3].children.single())
  }

  @Test
  fun `unchanged reductions reuse their display projection`() {
    var calls = 0
    val mapper =
      PrototypeRenderMapper(
        PrototypeValueFormatter { _, value ->
          calls++
          value.toString()
        },
      )
    val source = spec()
    mapper.map(source, emptyMap())
    assertEquals(1, calls)
    mapper.map(source.copy(state = mapOf("query" to PrototypeScalar.Text("alp"))), emptyMap())
    assertEquals(1, calls)
  }

  @Test
  fun `unrelated data branches preserve cached results`() {
    val recomputed = mutableListOf<String>()
    val cache = PrototypeDerivedValuesCache(PrototypeDeriveObserver { recomputed += it })
    val source = spec()
    val initial = cache.evaluate(source)
    recomputed.clear()
    val updated = source.copy(data = JsonObject(source.data!! + ("unrelated" to JsonPrimitive(1))))
    val result = cache.evaluate(updated)
    assertTrue(recomputed.isEmpty())
    assertSame(initial["rows"], result["rows"])
    assertSame(initial["total"], result["total"])
  }

  @Test
  fun `lazy derived rows follow the same query and stable keys`() {
    val source =
      spec()
        .copy(
          root =
            PrototypeListNode(
              repeat = PrototypeRepeat(emptyList(), "row", key = "id", itemsDerived = "rows"),
              children = listOf(PrototypeTextNode(text = "{row.name}")),
            ),
        )
    val mapper = PrototypeRenderMapper(FakePrototypeValueFormatter())
    val first = mapper.map(source, emptyMap()).root.list!!
    val filtered =
      mapper
        .map(source.copy(state = mapOf("query" to PrototypeScalar.Text("beta"))), emptyMap())
        .root
        .list!!
    assertEquals(listOf("a", "b"), first.rows.indices.map(first::key))
    assertEquals("b", filtered.key(0))
    assertEquals("Beta", filtered.render(filtered.rows.single(), 0).text)
  }
}
