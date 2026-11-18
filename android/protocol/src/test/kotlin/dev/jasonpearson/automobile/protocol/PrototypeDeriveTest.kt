package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeDeriveTest {
  companion object {
    private val cases =
      Json.parseToJsonElement(
          File(fixtureDirectory(), "derive/collections.json").readText(),
        )
        .jsonArray
        .map { it.jsonObject }

    @JvmStatic
    @BeforeAll
    fun warm() {
      PrototypeDeriveTest().checkCase(cases.first())
    }
  }

  private class Counter : PrototypeDeriveObserver {
    val names = mutableListOf<String>()

    override fun recomputed(name: String) {
      names += name
    }
  }

  @TestFactory
  fun `shared collection fixtures`(): List<DynamicTest> = cases.map { case ->
    DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) { checkCase(case) }
  }

  private fun spec(derive: JsonElement, data: JsonElement? = null, state: JsonElement? = null) =
    buildJsonObject {
      put("id", "collections")
      put("window", Json.parseToJsonElement("""{"placement":{"type":"fullscreen"}}"""))
      put("root", Json.parseToJsonElement("""{"type":"text","text":"ok"}"""))
      put("derive", derive)
      data?.let { put("data", it) }
      state?.let { put("state", it) }
    }

  private fun checkCase(case: JsonObject) {
    val error = case["error"] as? JsonObject
    if (error != null) {
      val result = PrototypeSpecValidator.validate(spec(case.getValue("derive")).toString())
      assertTrue(result is PrototypeSpecValidation.Failure, "$result")
      assertEquals(
        PrototypeSpecError(
          error.getValue("path").jsonPrimitive.content,
          error.getValue("message").jsonPrimitive.content,
        ),
        (result as PrototypeSpecValidation.Failure).error,
      )
      return
    }
    val derive = case.getValue("spec").jsonObject.getValue("derive")
    val entries =
      PrototypeSpecValidator.json.decodeFromJsonElement<Map<String, PrototypeDerivedEntry>>(derive)
    var data = case.getValue("data").jsonObject
    var state = case.getValue("state").jsonObject
    val counter = Counter()
    var values = PrototypeDerive.evaluate(entries, data, state, observer = counter)
    assertValues(case.getValue("expected"), JsonObject(values.mapValues { it.value ?: JsonNull }))
    assertTrue(
      PrototypeSpecValidator.validate(spec(derive, data, state).toString())
        is PrototypeSpecValidation.Success,
    )
    for (change in (case["changes"] as? JsonArray).orEmpty()) {
      val next = change.jsonObject
      val states = (next["state"] as? JsonObject).orEmpty()
      val writes = (next["data"] as? JsonObject).orEmpty()
      state = JsonObject(state + states)
      data = JsonObject(data + writes)
      counter.names.clear()
      val previous = values
      values =
        PrototypeDerive.evaluate(
          entries,
          data,
          state,
          previous,
          PrototypeDeriveChanges(writes.keys.mapTo(mutableSetOf()) { "/$it" }, states.keys),
          counter,
        )
      assertEquals(
        next.getValue("expectRecomputed").jsonArray.map { it.jsonPrimitive.content },
        counter.names,
      )
      previous.keys.filter { it !in counter.names }.forEach { assertSame(previous[it], values[it]) }
    }
  }

  private fun assertValues(expected: JsonElement, actual: JsonElement) {
    when (expected) {
      is JsonObject -> {
        assertEquals(expected.keys, actual.jsonObject.keys)
        expected.forEach { (key, value) -> assertValues(value, actual.jsonObject.getValue(key)) }
      }
      is JsonArray -> {
        assertEquals(expected.size, actual.jsonArray.size)
        expected.forEachIndexed { index, value -> assertValues(value, actual.jsonArray[index]) }
      }
      is JsonPrimitive ->
        if (!expected.isString && expected.doubleOrNull != null)
          assertEquals(expected.double, actual.jsonPrimitive.double, 0.0)
        else assertEquals(expected, actual)
    }
  }

  @Test
  fun `scan is capped before filtering and source objects retain identity`() {
    val rows =
      JsonArray(
        (0..500).map {
          buildJsonObject {
            put("id", it)
            put("n", it)
          }
        },
      )
    val entry =
      PrototypeDerivedEntry(
        collection = Json.parseToJsonElement("""{"of":{"data":"/rows"}}""").jsonObject,
      )
    val values =
      PrototypeDerive.evaluate(
        mapOf("rows" to entry),
        buildJsonObject { put("rows", rows) },
        emptyMap(),
      )
    val result = values.getValue("rows")!!.jsonArray
    assertEquals(500, result.size)
    assertSame(rows[0], result[0])
  }

  @Test
  fun `ancestor and descendant writes invalidate only the dependent entry`() {
    val entry =
      PrototypeDerivedEntry(
        collection = Json.parseToJsonElement("""{"of":{"data":"/group/rows"}}""").jsonObject,
      )
    val entries =
      mapOf(
        "rows" to entry,
        "literal" to PrototypeDerivedEntry(of = buildJsonObject { put("value", 2) }),
      )
    val before = PrototypeDerive.evaluate(entries, null, emptyMap())
    for (path in listOf("/group", "/group/rows/0", "/grouping")) {
      val counter = Counter()
      val after =
        PrototypeDerive.evaluate(
          entries,
          null,
          emptyMap(),
          before,
          PrototypeDeriveChanges(setOf(path)),
          counter,
        )
      assertEquals(if (path == "/grouping") emptyList<String>() else listOf("rows"), counter.names)
      assertSame(before["literal"], after["literal"])
    }
  }

  @Test
  fun `repeat source semantic errors use authored paths`() {
    val entries =
      Json.parseToJsonElement(
        """{
      "rows":{"collection":{"of":{"data":"/rows"}}},
      "total":{"collection":{"of":{"data":"/rows"}},"reduce":{"op":"count"}}
    }""",
      )
    for ((name, message) in
      listOf(
        "absent" to "Unknown derived value \"absent\"",
        "total" to "Repeat derived items must name a collection without reduce",
      )) {
      val root =
        Json.parseToJsonElement(
          """{"type":"column","repeat":{"items":{"derived":"$name"},"as":"row"},"children":[{"type":"text","text":"ok"}]}""",
        )
      val input = JsonObject(spec(entries) + ("root" to root))
      val result =
        PrototypeSpecValidator.validate(input.toString()) as PrototypeSpecValidation.Failure
      assertEquals(PrototypeSpecError("root.repeat.items.derived", message), result.error)
    }
  }

  @Test
  fun `derived repeat validates fields collisions and round trips its source`() {
    val derive = Json.parseToJsonElement("""{"rows":{"collection":{"of":{"data":"/rows"}}}}""")
    val data = Json.parseToJsonElement("""{"rows":[{"id":"a","n":1}]}""")
    val root =
      Json.parseToJsonElement(
          """{"type":"column","repeat":{"items":{"derived":"rows"},"as":"row","key":"id"},"children":[{"type":"text","text":"{row.n}"}]}""",
        )
        .jsonObject
    val input = JsonObject(spec(derive, data) + ("root" to root))
    val result = PrototypeSpecValidator.validate(input.toString())
    assertTrue(result is PrototypeSpecValidation.Success, "$result")
    val decoded = (result as PrototypeSpecValidation.Success).spec
    val repeat = (decoded.root as PrototypeColumnNode).repeat!!
    assertEquals("rows", repeat.itemsDerived)
    val json = PrototypeSpecValidator.json
    assertEquals(
      repeat,
      json.decodeFromJsonElement<PrototypeRepeat>(json.encodeToJsonElement(repeat)),
    )
    val missing =
      JsonObject(
        root +
          ("children" to Json.parseToJsonElement("""[{"type":"text","text":"{row.missing}"}]""")),
      )
    val invalid =
      PrototypeSpecValidator.validate(JsonObject(input + ("root" to missing)).toString())
        as PrototypeSpecValidation.Failure
    assertEquals(
      PrototypeSpecError("root.children[0].text", "Unknown repeat field \"missing\""),
      invalid.error,
    )
    val repeated = root.getValue("repeat").jsonObject
    val collision =
      JsonObject(
        repeated +
          ("derive" to
            Json.parseToJsonElement("""{"n":{"of":{"item":"n"},"format":{"number":{}}}}""")),
      )
    val collidingRoot = JsonObject(root + ("repeat" to collision))
    val colliding =
      PrototypeSpecValidator.validate(JsonObject(input + ("root" to collidingRoot)).toString())
        as PrototypeSpecValidation.Failure
    assertEquals(
      PrototypeSpecError("root.repeat.derive.n", "Derived name collides with an item field"),
      colliding.error,
    )
  }

  @Test
  fun `unformatted collections require derive capability without format capability`() {
    val derive = Json.parseToJsonElement("""{"rows":{"collection":{"of":{"data":"/rows"}}}}""")
    val required =
      PrototypeBundleCapabilities.required(
        PrototypeBundleSpec.references(spec(derive).toString().toByteArray()),
      )
    assertEquals(listOf("prototype_derive_v1"), required)
  }

  @Test
  fun `mixed sort keeps missing values last in either direction`() {
    val rows =
      Json.parseToJsonElement("""[{"n":"a"},{"n":2},{},{"n":1},{"n":true},{"n":2}]""").jsonArray
    for ((order, indices) in
      listOf("asc" to listOf(3, 1, 5, 0, 2, 4), "desc" to listOf(0, 1, 5, 3, 2, 4))) {
      val entry =
        PrototypeDerivedEntry(
          collection =
            Json.parseToJsonElement(
                """{"of":{"data":"/rows"},"sort":{"field":"n","order":"$order"}}""",
              )
              .jsonObject,
        )
      val result =
        PrototypeDerive.evaluate(
            mapOf("rows" to entry),
            buildJsonObject { put("rows", rows) },
            emptyMap(),
          )
          .getValue("rows")!!
          .jsonArray
      indices.forEachIndexed { index, source -> assertSame(rows[source], result[index]) }
    }
  }

  private fun repeatSpec(limit: String) =
    Json.parseToJsonElement(
        """
        {"id":"collections","window":{"placement":{"type":"fullscreen"}},
         "data":{"rows":[{"id":"a"},{"id":"b"}]},
         "derive":{"rows":{"collection":{"of":{"data":"/rows"},"limit":$limit}}},
         "root":{"type":"column","children":[
           {"type":"column","repeat":{"items":{"derived":"rows"},"as":"row"},
            "children":[{"type":"text","text":"{row.id}"}]},
           {"type":"column","repeat":{"items":{"derived":"rows"},"as":"row"},
            "children":[{"type":"text","text":"{row.id}"}]}]}}
        """
          .trimIndent(),
      )
      .jsonObject

  @Test
  fun `integral decimal limits validate and evaluate without crashing`() {
    for (limit in listOf("1.0", "1e2")) {
      val result = PrototypeSpecValidator.validate(repeatSpec(limit).toString())
      assertTrue(result is PrototypeSpecValidation.Success, "$limit: $result")
    }
    val fractional = PrototypeSpecValidator.validate(repeatSpec("1.5").toString())
    assertEquals(
      PrototypeSpecError("derive.rows.collection.limit", "Invalid number value"),
      (fractional as PrototypeSpecValidation.Failure).error,
    )
  }

  @Test
  fun `spec derived values evaluate once per spec revision`() {
    val counter = Counter()
    val spec = repeatSpec("1")
    val first = PrototypeDerive.fromSpec(spec, counter)
    assertSame(first, PrototypeDerive.fromSpec(spec, counter))
    assertEquals(listOf("rows"), counter.names)
    PrototypeDerive.fromSpec(repeatSpec("2"), counter)
    assertEquals(listOf("rows", "rows"), counter.names)
  }
}
