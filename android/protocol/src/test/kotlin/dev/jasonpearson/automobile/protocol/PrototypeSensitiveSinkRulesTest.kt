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
