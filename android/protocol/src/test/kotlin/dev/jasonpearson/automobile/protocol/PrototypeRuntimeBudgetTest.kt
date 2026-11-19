package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The per-runtime budget (#18804): the overlay keeps the base limits, activity hosts the large. */
class PrototypeRuntimeBudgetTest {
  private val large = PrototypeRuntimeBudget.LARGE
  private val mib = 1024 * 1024

  private fun rows(count: Int) = buildJsonArray {
    repeat(count) { index -> add(buildJsonObject { put("id", index) }) }
  }

  private fun feed(
    rows: Int,
    list: Map<String, Int> = emptyMap(),
    extraData: Map<String, String> = emptyMap(),
  ): String = buildJsonObject {
    put("id", "feed")
    putJsonObject("window") { putJsonObject("placement") { put("type", "fullscreen") } }
    putJsonObject("state") { put("seen", false) }
    putJsonObject("root") {
      put("type", "list")
      putJsonObject("repeat") {
        putJsonObject("items") { put("path", "/feed/items") }
        put("as", "post")
        put("key", "id")
      }
      putJsonArray("children") {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", "{post.id}")
          },
        )
      }
      for ((key, value) in list) put(key, value)
    }
    putJsonObject("data") {
      putJsonObject("feed") { put("items", rows(rows)) }
      for ((key, value) in extraData) put(key, value)
    }
  }
    .toString()

  private fun failure(result: PrototypeSpecValidation): PrototypeSpecError =
    (result as? PrototypeSpecValidation.Failure)?.error
      ?: error("Expected a validation failure, got $result")

  @Test
  fun `budgets come from the contract limits and runtimeBudgets table`() {
    val contract =
      Json.parseToJsonElement(
          checkNotNull(javaClass.getResourceAsStream("/prototype-spec-contract.json"))
            .bufferedReader()
            .use { it.readText() },
        )
        .jsonObject
    val limits = contract.getValue("limits").jsonObject
    val table =
      contract
        .getValue("runtimeBudgets")
        .jsonObject
        .getValue(PrototypeRuntimeBudget.LARGE_BUDGET_CAPABILITY)
        .jsonObject
    for ((name, value) in table) {
      assertEquals(value.jsonPrimitive.int, large.limit(name), name)
      assertEquals(limits.getValue(name).jsonPrimitive.int, PrototypeRuntimeBudget.BASE.limit(name))
    }
    assertEquals(PrototypeRuntimeBudget(4 * mib, 3 * mib, 3 * mib, 10000, 10000), large)
    assertNull(large.limit("MAX_PROTOTYPE_NODES"))
  }

  @Test
  fun `a runtime gets the large budget only when it advertises the capability`() {
    assertSame(PrototypeRuntimeBudget.BASE, PrototypeRuntimeBudget.forCapabilities(null))
    assertSame(
      PrototypeRuntimeBudget.BASE,
      PrototypeRuntimeBudget.forCapabilities(setOf("prototype_lazy_list_v1")),
    )
    assertSame(
      large,
      PrototypeRuntimeBudget.forCapabilities(setOf(PrototypeRuntimeBudget.LARGE_BUDGET_CAPABILITY)),
    )
  }

  @Test
  fun `a list over the base item limit validates only against the large budget`() {
    val spec = feed(2001)
    val base = failure(PrototypeSpecValidator.validate(spec))
    assertEquals("root.repeat.items.path", base.path)
    assertEquals("Repeat path resolves to more than 2000 items", base.message)
    assertTrue(
      PrototypeSpecValidator.validate(spec, budget = large) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `list maxItems follows the budget`() {
    assertEquals(
      PrototypeSpecError("root.maxItems", "Invalid number value"),
      failure(PrototypeSpecValidator.validate(feed(1, mapOf("maxItems" to 5000)))),
    )
    assertTrue(
      PrototypeSpecValidator.validate(feed(1, mapOf("maxItems" to 5000)), budget = large)
        is PrototypeSpecValidation.Success,
    )
    assertEquals(
      "root.maxItems",
      failure(PrototypeSpecValidator.validate(feed(1, mapOf("maxItems" to 10001)), budget = large))
        .path,
    )
  }

  @Test
  fun `spec and data bytes over the base budget validate only against the large budget`() {
    val spec = feed(1, extraData = mapOf("blob" to "x".repeat(mib + 4096)))
    assertEquals(
      PrototypeSpecError("$", "Spec byte limit exceeded"),
      failure(PrototypeSpecValidator.validate(spec)),
    )
    assertTrue(
      PrototypeSpecValidator.validate(spec, budget = large) is PrototypeSpecValidation.Success,
    )
    val data = feed(1, extraData = mapOf("blob" to "x".repeat(800 * 1024)))
    assertEquals(
      PrototypeSpecError("data", "Data byte limit exceeded"),
      failure(PrototypeSpecValidator.validate(data)),
    )
    assertTrue(
      PrototypeSpecValidator.validate(data, budget = large) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `device data writes follow the runtime budget`() {
    val data = buildJsonObject { put("items", rows(2000)) }
    val append = PrototypeDataWrite.Append("/data/items", buildJsonObject { put("id", 2000) })
    val base = PrototypeDataWriter.apply(data, append)
    assertEquals(
      PrototypeDataWriteErrorCode.LIMIT_EXCEEDED,
      (base as PrototypeDataWriteResult.Failure).error.code,
    )
    val grown = PrototypeDataWriter.apply(data, append, large)
    assertEquals(
      2001,
      ((grown as PrototypeDataWriteResult.Success).data["items"] as JsonArray).size,
    )
    val windowed = PrototypeDataWrite.Append("/data/items", JsonPrimitive(1), maxItems = 5000)
    val empty = buildJsonObject { put("items", rows(0)) }
    val refused = PrototypeDataWriter.apply(empty, windowed) as PrototypeDataWriteResult.Failure
    assertEquals("append maxItems must be a positive safe integer", refused.error.message)
    assertTrue(
      PrototypeDataWriter.apply(empty, windowed, large) is PrototypeDataWriteResult.Success,
    )
  }

  @Test
  fun `state writes on a spec over the base byte limit follow the budget`() {
    val json = Json { encodeDefaults = false }
    val spec =
      (PrototypeSpecValidator.validate(
          feed(1, extraData = mapOf("blob" to "x".repeat(mib + 4096))),
          budget = large,
        ) as PrototypeSpecValidation.Success)
        .spec
    val state = mapOf("seen" to PrototypeScalar.BooleanValue(true))
    assertEquals(
      "Spec byte limit exceeded",
      PrototypeSpecValidator.prepareStateWrites(spec, json).validate(state)?.message,
    )
    assertNull(PrototypeSpecValidator.prepareStateWrites(spec, json, large).validate(state))
  }

  private fun withRoot(
    spec: String,
    extra: Map<String, JsonElement>,
  ): String = JsonObject(Json.parseToJsonElement(spec).jsonObject + extra).toString()

  @Test
  fun `a setData literal follows the budget`() {
    val root = Json.parseToJsonElement(feed(1)).jsonObject.getValue("root").jsonObject
    val onEnd = buildJsonArray {
      add(
        buildJsonObject {
          put("type", "setData")
          put("path", "/data/more")
          putJsonObject("value") { put("value", rows(2001)) }
        },
      )
    }
    val spec = withRoot(feed(1), mapOf("root" to JsonObject(root + ("onEndReached" to onEnd))))
    assertTrue(PrototypeSpecValidator.validate(spec) is PrototypeSpecValidation.Failure)
    assertTrue(
      PrototypeSpecValidator.validate(spec, budget = large) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `a stored data value restores against the runtime budget`() {
    val storage = buildJsonObject {
      put("version", 1)
      putJsonArray("keys") { add(JsonPrimitive("data:/flag")) }
    }
    val data =
      Json.parseToJsonElement(feed(2001)).jsonObject.getValue("data").jsonObject +
        ("flag" to JsonPrimitive(false))
    val json = withRoot(feed(2001), mapOf("storage" to storage, "data" to JsonObject(data)))
    val spec =
      (PrototypeSpecValidator.validate(json, budget = large) as PrototypeSpecValidation.Success)
        .spec
    val stored = PrototypeStoredValues(1, mapOf("data:/flag" to JsonPrimitive(true)))
    val base = PrototypeStorageRestorer.restore(spec, stored)
    assertEquals(listOf("data:/flag"), base.dropped.map { it.key })
    val restored = PrototypeStorageRestorer.restore(spec, stored, large)
    assertEquals(listOf("data:/flag"), restored.applied)
    assertEquals(JsonPrimitive(true), restored.spec.data?.get("flag"))
  }
}
