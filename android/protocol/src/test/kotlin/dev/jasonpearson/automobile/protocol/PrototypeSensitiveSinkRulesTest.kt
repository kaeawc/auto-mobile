package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeSensitiveSinkRulesTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      val fixture =
        Json.parseToJsonElement(
            File(fixtureDirectory(), "library-sensitive/storage-exact.json").readText(),
          )
          .jsonObject
      PrototypeSpecValidator.validate(fixture.getValue("spec").toString(), library = true)
    }
  }

  @TestFactory
  fun sharedSensitiveFixtures(): List<DynamicTest> =
    File(fixtureDirectory(), "library-sensitive")
      .listFiles()!!
      .filter { it.extension == "json" }
      .sortedBy { it.name }
      .map { file ->
        val fixture = Json.parseToJsonElement(file.readText()).jsonObject
        val spec = fixture.getValue("spec").toString()
        DynamicTest.dynamicTest(file.name) {
          assertTrue(PrototypeSpecValidator.validate(spec) is PrototypeSpecValidation.Success)
          val path = fixture["expectedPath"]?.jsonPrimitive?.content
          if (path != null) {
            assertEquals(
              PrototypeSpecValidation.Failure(
                PrototypeSpecError(path, fixture.getValue("expectedMessage").jsonPrimitive.content),
              ),
              PrototypeSpecValidator.validate(spec, library = true),
            )
          } else {
            // R1 refuses this spec's sensitive source in a library, so check R2 directly.
            assertEquals(emptyList<PrototypeSpecError>(), sinkErrors(spec), file.name)
          }
          if (file.name == "repeat-item-copy.json") {
            val clean = spec.replace("/data/rows/0/code", "/data/other")
            assertTrue(PrototypeSpecValidator.validate(clean) is PrototypeSpecValidation.Success)
            assertEquals(emptyList<PrototypeSpecError>(), sinkErrors(clean))
          }
        }
      }

  @Test
  fun taintedStateReachesRequestBindingsAndText() {
    val action = """{"type":"setState","key":"u","value":{"platform":"/auth/userId"}}"""
    for ((query, suffix) in listOf("""{"state":"u"}""" to ".state", """"{u}"""" to "")) {
      assertEquals(
        listOf(
          PrototypeSpecError(
            "root.onTap[1].query.q$suffix",
            "Sensitive value cannot be bound into a request",
          ),
        ),
        sinkErrors(stateSpec(action, query)),
      )
    }
  }

  @Test
  fun clearingAfterSensitiveCopyDoesNotErasePossibleTaint() {
    val actions =
      """
      {"type":"setState","key":"u","value":{"platform":"/auth/userId"}},
      {"type":"setState","key":"u","value":""},
      {"type":"setData","path":"/data/leak","value":{"state":"u"}}
      """
        .trimIndent()
    assertEquals(
      listOf(
        PrototypeSpecError(
          "root.onTap[3].query.q",
          "Sensitive value cannot be bound into a request",
        ),
      ),
      sinkErrors(stateSpec(actions, """{"data":"/leak"}""")),
    )
    assertEquals(
      emptyList<PrototypeSpecError>(),
      sinkErrors(stateSpec("""{"type":"setState","key":"u","value":""}""", """{"state":"u"}""")),
    )
  }

  @Test
  fun stateTextPlatformPlaceholderReachesStorage() {
    val spec =
      stateSpec(
        """{"type":"setState","key":"u","value":"User {platform:/auth/userId}"}""",
        """"clean"""",
      )
    val stored = buildJsonObject {
      Json.parseToJsonElement(spec).jsonObject.forEach { (key, value) -> put(key, value) }
      putJsonObject("storage") {
        put("version", 1)
        putJsonArray("keys") { add("state:u") }
      }
    }
    assertEquals(
      listOf(PrototypeSpecError("storage.keys[0]", "Sensitive value cannot be persisted")),
      sinkErrors(stored.toString()),
    )
  }

  @Test
  fun stateTemplatesMatchLiteralPrefixesAndChargeBudget() {
    val budget = PrototypeSensitiveSinkIndex.Budget(20)
    val index = PrototypeStateTaintIndex(listOf("pick_{index}", "literal"), budget::visit)
    assertTrue(index.key("pick_99"))
    assertTrue(index.key("pick_{row.id}"))
    assertFalse(index.key("other"))
    assertTrue(index.text("send {pick_99}"))
    assertTrue(index.text("send {literal}"))
    assertFalse(index.text("send {literalSuffix}"))
    assertTrue(budget.checks > 0)
    val exhausted =
      PrototypeStateTaintIndex(listOf("u"), PrototypeSensitiveSinkIndex.Budget(0)::visit)
    assertFalse(exhausted.key("u"))
    assertFalse(exhausted.text("{u}"))
  }

  @Test
  fun stateCopyPropagationSpendsTheCheckCap() {
    val context = PrototypeStateChecks.Context()
    val spec =
      stateSpec(
        """
        {"type":"setState","key":"u","value":{"platform":"/auth/userId"}},
        {"type":"setData","path":"/data/leak","value":{"state":"u"}}
        """
          .trimIndent(),
        """{"data":"/leak"}""",
      )
    assertTrue(PrototypeSpecInput.validateInput(spec, context) !is PrototypeSpecValidation.Failure)
    fun propagate(cap: Long) =
      PrototypeCopyTaint.propagate(
        emptyList(),
        listOf("/auth/userId"),
        context,
        PrototypeSensitiveSinkIndex.Companion::overlaps,
        maxChecks = cap,
      )
    assertNull(propagate(1))
    assertEquals(PrototypeCopyTaint.Taints(listOf("/leak"), listOf("u")), propagate(2))
  }

  private fun stateSpec(actions: String, query: String): String =
    """
    {
      "id":"sensitive-flow",
      "window":{"placement":{"type":"fullscreen"}},
      "requires":{"platform":["auth"]},
      "state":{"u":""},
      "root":{"type":"button","label":"Copy","onTap":[
        $actions,
        {"type":"request","url":"https://example.com/submit","via":"device","query":{"q":$query}}
      ]}
    }
  """
      .trimIndent()

  @Test
  fun manyTaintsAndUnrelatedBindingsCostBoundedOverlapChecks() {
    val taints = 3000
    val unrelated = 5000
    val copiesPerButton = 30
    val queriesPerRequest = 15
    val requestsPerButton = 30
    val copyButtons = taints / copiesPerButton
    val spec = buildJsonObject {
      put("id", "sensitive-sink-scan")
      putJsonObject("window") { putJsonObject("placement") { put("type", "fullscreen") } }
      putJsonObject("requires") { putJsonArray("platform") { add("auth") } }
      putJsonObject("root") {
        put("type", "column")
        putJsonArray("children") {
          addCopyButtons(copyButtons, copiesPerButton)
          addRequestButtons(taints, unrelated, queriesPerRequest, requestsPerButton)
        }
      }
    }
    val context = PrototypeStateChecks.Context()
    val input = PrototypeSpecInput.validateInput(spec.toString(), context)
    assertTrue(input !is PrototypeSpecValidation.Failure, input.toString())
    val result = PrototypeSensitiveSinkRules.scan(spec, context)
    assertEquals(
      listOf(
        PrototypeSpecError(
          "root.children[$copyButtons].onTap[0].query.secret",
          "Sensitive value cannot be bound into a request",
        ),
      ),
      result.errors,
    )
    assertTrue(
      result.checks <= 8 * (unrelated + 1) + taints,
      "${result.checks} overlap checks exceed ${8 * (unrelated + 1) + taints}",
    )
  }

  private fun JsonArrayBuilder.addCopyButtons(copyButtons: Int, copiesPerButton: Int) {
    repeat(copyButtons) { button ->
      addJsonObject {
        put("type", "button")
        put("label", "Copy $button")
        putJsonArray("onTap") {
          repeat(copiesPerButton) { offset ->
            addJsonObject {
              put("type", "setData")
              put("path", "/data/copy${button * copiesPerButton + offset}")
              putJsonObject("value") { put("platform", "/auth/userId") }
            }
          }
        }
      }
    }
  }

  private fun JsonArrayBuilder.addRequestButtons(
    taints: Int,
    unrelated: Int,
    queriesPerRequest: Int,
    requestsPerButton: Int,
  ) {
    val requestCount = (unrelated + queriesPerRequest - 1) / queriesPerRequest
    repeat((requestCount + requestsPerButton - 1) / requestsPerButton) { button ->
      addJsonObject {
        put("type", "button")
        put("label", "Send $button")
        putJsonArray("onTap") {
          repeat(minOf(requestsPerButton, requestCount - button * requestsPerButton)) { action ->
            val request = button * requestsPerButton + action
            addJsonObject {
              put("type", "request")
              put("url", "https://example.com/submit")
              put("via", "device")
              putJsonObject("query") {
                repeat(minOf(queriesPerRequest, unrelated - request * queriesPerRequest)) { offset
                  ->
                  val index = request * queriesPerRequest + offset
                  putJsonObject("q$index") { put("data", "/unrelated$index") }
                }
                if (request == 0) putJsonObject("secret") { put("data", "/copy${taints - 1}") }
              }
            }
          }
        }
      }
    }
  }

  private fun sinkErrors(input: String): List<PrototypeSpecError> {
    val context = PrototypeStateChecks.Context()
    val result = PrototypeSpecInput.validateInput(input, context)
    assertTrue(result !is PrototypeSpecValidation.Failure, result.toString())
    return PrototypeSensitiveSinkRules.errors(checkNotNull(context.root).jsonObject, context)
  }
}
