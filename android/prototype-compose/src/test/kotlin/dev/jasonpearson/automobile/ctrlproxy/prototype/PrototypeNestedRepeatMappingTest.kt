package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeNestedRepeatMappingTest {
  companion object {
    private val directory =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec") }
        .first { it.isDirectory }
    private val cases =
      listOf("nested.json", "nested-sources.json").flatMap { file ->
        Json.parseToJsonElement(File(directory, "repeat/$file").readText()).jsonArray
      }
    private val json = Json { ignoreUnknownKeys = false }

    private fun spec(case: JsonObject): PrototypeSpec =
      json.decodeFromJsonElement(
        PrototypeSpec.serializer(),
        JsonObject(
          case.getValue("spec").jsonObject + case.filterKeys { it == "data" || it == "state" },
        ),
      )

    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeRenderMapper(FakePrototypeValueFormatter())
        .map(spec(cases.first().jsonObject), emptyMap())
    }
  }

  @Test
  fun `shared fixtures expand to identical indexed rows`() {
    for (raw in cases) {
      val case = raw.jsonObject
      val source = spec(case)
      val mapped = PrototypeRenderMapper(FakePrototypeValueFormatter()).map(source, emptyMap()).root
      val rows =
        buildList<JsonElement> {
          mapped.children.forEachIndexed { outerIndex, outer ->
            val texts = outer.children.filter { it.role == "text" }
            // Every fixture groups the text templates inside one inner column.
            val count =
              source.root
                .let { (it as PrototypeColumnNode).children.single() }
                .let {
                  (it as PrototypeColumnNode).children.count { child -> child is PrototypeTextNode }
                }
            texts.chunked(count).forEachIndexed { innerIndex, group ->
              add(
                buildJsonObject {
                  put("outerIndex", outerIndex)
                  put("innerIndex", innerIndex)
                  put("texts", JsonArray(group.map { JsonPrimitive(it.text) }))
                },
              )
            }
          }
        }
      assertEquals(
        case.getValue("name").jsonPrimitive.content,
        case.getValue("expected").jsonObject.getValue("rows"),
        JsonArray(rows),
      )
      // Exercise both production mapping entry points.
      assertEquals(mapped, mapPrototypeSpec(source).root)
    }
  }

  @Test
  fun `representative orders keep one header and card per order`() {
    val source =
      json.decodeFromString(
        PrototypeSpec.serializer(),
        File(directory, "repeat/nested-orders.json").readText(),
      )
    val root = PrototypeRenderMapper(FakePrototypeValueFormatter()).map(source, emptyMap()).root
    assertEquals(listOf("card", "card"), root.children.map { it.role })
    assertEquals(
      listOf("Order A #0 Ada", "Order C #1 Cy"),
      root.children.map { it.children[0].text },
    )
    assertEquals(
      listOf("PEN x2 (A 0.0)", "INK x1 (A 0.1)", "PAD x3 (C 1.0)"),
      root.children.flatMap { it.children[1].children.map { child -> child.text } },
    )
  }

  @Test
  fun `lazy outer rows retain their nested object arrays`() {
    val source = spec(cases.first().jsonObject)
    val outer = source.root as PrototypeColumnNode
    val lazy =
      source.copy(
        root =
          PrototypeListNode(
            repeat = outer.repeat!!.copy(key = "id"),
            children = outer.children,
          ),
      )
    val mapped =
      PrototypeRenderMapper(FakePrototypeValueFormatter()).map(lazy, emptyMap()).root.list!!
    assertEquals(listOf("A", "B", "C"), mapped.rows.indices.map(mapped::key))
    assertEquals(
      listOf("0/0 A Ada: PEN x2", "0/1 A Ada: INK x1"),
      mapped.render(mapped.rows[0], 0).children.map { it.text },
    )
    assertTrue(mapped.render(mapped.rows[1], 1).children.isEmpty())
    assertEquals("2/0 C Cy: PAD x3", mapped.render(mapped.rows[2], 2).children.single().text)
  }

  @Test
  fun `nested capability is advertised and required by strict validation`() {
    assertTrue("prototype_nested_repeat_v1" in AutoMobilePrototype.capabilitiesForSdk(32))
    assertTrue("prototype_nested_repeat_v1" in AutoMobilePrototype.capabilitiesForSdk(33))
    val source = spec(cases.first().jsonObject)
    val encoded = json.encodeToString(PrototypeSpec.serializer(), source)
    val supported = AutoMobilePrototype.capabilitiesForSdk(33)
    assertTrue(
      PrototypeSpecValidator.validate(encoded, supported) is PrototypeSpecValidation.Success,
    )
    assertEquals(
      PrototypeSpecError("$", "Unsupported capabilities: prototype_nested_repeat_v1"),
      (PrototypeSpecValidator.validate(encoded, supported - "prototype_nested_repeat_v1")
          as PrototypeSpecValidation.Failure)
        .error,
    )
  }

  private fun identitySpec(
    ids: List<String>,
    outerKey: Boolean = true,
    innerKey: Boolean = true,
  ): PrototypeSpec {
    val source = spec(cases.first().jsonObject)
    val root = source.root as PrototypeColumnNode
    val inner = root.children.single() as PrototypeColumnNode
    return source.copy(
      root =
        root.copy(
          repeat = root.repeat!!.copy(key = if (outerKey) "id" else null),
          children =
            listOf(
              inner.copy(
                repeat = inner.repeat!!.copy(key = if (innerKey) "sku" else null),
                children =
                  listOf(
                    PrototypeTextNode(text = "{order.id}/{line.sku}"),
                    PrototypeTextNode(text = "second {line.sku}"),
                  ),
              ),
            ),
        ),
      data =
        buildJsonObject {
          put(
            "orders",
            JsonArray(
              ids.map { id ->
                buildJsonObject {
                  put("id", id)
                  put("lines", buildJsonArray { add(buildJsonObject { put("sku", "shared") }) })
                }
              },
            ),
          )
        },
    )
  }

  @Test
  fun `composed identity survives outer reorder and insertion without inner key collisions`() {
    fun identities(ids: List<String>): Map<String, List<String>> {
      val root =
        PrototypeRenderMapper(FakePrototypeValueFormatter()).map(identitySpec(ids), emptyMap()).root
      return ids.zip(root.children).associate { (id, outer) ->
        assertEquals(
          listOf(0, 1).map { "root.repeat[$id].children[0].repeat[shared].children[$it]" },
          outer.children.map { it.identity },
        )
        id to listOf(outer.identity) + outer.children.map { it.identity }
      }
    }
    val before = identities(listOf("A", "B"))
    assertEquals(before, identities(listOf("B", "A")))
    val inserted = identities(listOf("NEW", "B", "A"))
    assertEquals(before["A"], inserted["A"])
    assertEquals(before["B"], inserted["B"])
    val all = inserted.values.flatten()
    assertEquals(all.size, all.toSet().size)
  }

  @Test
  fun `identity falls back to index only without a declared key`() {
    val mapper = PrototypeRenderMapper(FakePrototypeValueFormatter())
    val inner = mapper.map(identitySpec(listOf("A", "B"), innerKey = false), emptyMap()).root
    assertEquals(
      "root.repeat[A].children[0].repeat[0].children[0]",
      inner.children[0].children[0].identity,
    )
    assertEquals(
      "root.repeat[B].children[0].repeat[0].children[0]",
      inner.children[1].children[0].identity,
    )
    val outer = mapper.map(identitySpec(listOf("A", "B"), outerKey = false), emptyMap()).root
    assertEquals(
      "root.repeat[0].children[0].repeat[shared].children[0]",
      outer.children[0].children[0].identity,
    )
    assertEquals(
      "root.repeat[1].children[0].repeat[shared].children[0]",
      outer.children[1].children[0].identity,
    )
  }

  @Test
  fun `row data changes refresh nested rows without reusing old source arrays`() {
    val source = spec(cases.first().jsonObject)
    val mapper = PrototypeRenderMapper(FakePrototypeValueFormatter())
    val before = mapper.map(source, emptyMap()).root
    val orders = source.data!!.getValue("orders").jsonArray
    val first = orders[0].jsonObject
    val changed =
      source.copy(
        data =
          JsonObject(
            source.data!! +
              ("orders" to
                JsonArray(
                  listOf(JsonObject(first + ("lines" to JsonArray(emptyList())))) + orders.drop(1),
                )),
          ),
      )
    val after = mapper.map(changed, emptyMap()).root
    assertEquals(2, before.children[0].children.size)
    assertTrue(after.children[0].children.isEmpty())
    assertEquals(
      before.children[2].children.map { it.text },
      after.children[2].children.map { it.text },
    )
  }
}
