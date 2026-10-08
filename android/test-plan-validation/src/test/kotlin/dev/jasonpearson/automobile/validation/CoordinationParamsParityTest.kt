package dev.jasonpearson.automobile.validation

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * criticalSection lock consistency and barrier per-step params. The plan-level cases come from
 * `test/fixtures/plan-coordination-params/cases.json`, which the daemon's
 * `test/utils/plan/PlanValidatorCoordinationParams.test.ts` also runs against PlanValidator, so
 * both validators must reach the same verdict and the same messages in the same order.
 */
class CoordinationParamsParityTest {

  @Test
  fun `shared fixture cases reach the daemon's verdicts and messages`() {
    val cases = fixtureCases
    assertTrue(cases.size >= 10, "expected shared coordination-param cases, found ${cases.size}")
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val expected = case.getValue("expected").jsonObject
      // JSON is a YAML subset, so the fixture plan feeds the YAML entry point directly.
      val result = TestPlanValidator.validateYaml(case.getValue("plan").toString())
      if (expected.getValue("valid").jsonPrimitive.boolean) {
        assertTrue(result.valid, "$name: expected valid, got ${result.errors}")
        assertEquals(emptyList(), result.errors, name)
        continue
      }
      // The daemon joins one check's errors with newlines and throws at its first failing check;
      // Kotlin reports each error separately and also lists schema errors and later checks. The
      // daemon's messages must therefore appear as one contiguous, ordered run.
      val daemonMessages = expected.getValue("message").jsonPrimitive.content.split("\n")
      val kotlinMessages = result.errors.map { it.message }
      assertTrue(
        kotlinMessages.windowed(daemonMessages.size).any { it == daemonMessages },
        "$name: expected $daemonMessages within $kotlinMessages",
      )
      // Any earlier coordination failure must pre-empt the deadlock search, as in the daemon.
      if (daemonMessages.none { it.contains("coordination can never complete") }) {
        assertTrue(kotlinMessages.none { it.contains("coordination can never complete") }, name)
      }
    }
  }

  @Test
  fun `criticalSection lock errors suppress the deadlock report like the daemon`() {
    val yaml =
      """
      name: cs-count-and-deadlock
      devices: [A, B]
      steps:
        - { tool: criticalSection, params: { device: A, lock: L, deviceCount: 2, steps: [] } }
        - { tool: criticalSection, params: { device: B, lock: L, deviceCount: 3, steps: [] } }
      """
        .trimIndent()
    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.errors.none { it.message.contains("coordination can never complete") })
    assertTrue(result.errors.any { it.message.contains("inconsistent deviceCount values") })
  }

  private companion object {
    const val RELATIVE_FIXTURE = "test/fixtures/plan-coordination-params/cases.json"

    val fixtureCases: List<JsonObject> by lazy {
      val file =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, RELATIVE_FIXTURE) }
          .firstOrNull { it.isFile } ?: error("Could not locate $RELATIVE_FIXTURE")
      Json.parseToJsonElement(file.readText()).jsonObject.getValue("cases").jsonArray.map {
        it.jsonObject
      }
    }
  }
}
