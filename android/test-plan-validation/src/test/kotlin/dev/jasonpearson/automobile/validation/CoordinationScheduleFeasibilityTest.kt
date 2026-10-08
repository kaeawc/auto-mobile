package dev.jasonpearson.automobile.validation

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Issue #6231: static scheduling feasibility for multi-lock barrier plans. The plan-level cases
 * come from `test/fixtures/plan-schedule-feasibility/cases.json`, which the daemon's
 * `test/utils/plan/PlanValidatorScheduleFeasibility.test.ts` also runs against PlanValidator, so
 * both validators must reach the same verdict and the same exact message.
 */
class CoordinationScheduleFeasibilityTest {

  @Test
  fun `shared fixture cases reach the daemon's verdicts and messages`() {
    val cases = fixtureCases
    assertTrue(cases.size >= 2, "expected shared feasibility cases, found ${cases.size}")
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val expected = case.getValue("expected").jsonObject
      // JSON is a YAML subset, so the fixture plan feeds the YAML entry point directly.
      val result = TestPlanValidator.validateYaml(case.getValue("plan").toString())
      if (expected.getValue("valid").jsonPrimitive.boolean) {
        assertTrue(result.valid, "$name: expected valid, got ${result.errors}")
        assertEquals(emptyList(), result.errors, name)
      } else {
        val message = expected.getValue("message").jsonPrimitive.content
        assertEquals(listOf(message), result.errors.map { it.message }, name)
        assertEquals(listOf("steps"), result.errors.map { it.field }, name)
      }
    }
  }

  @Test
  fun `feasibility check is skipped while an earlier coordination check fails`() {
    // AB-BA cycle plus an undeclared device on an unrelated barrier: the daemon stops at the
    // membership error, so the deadlock error must not be reported here either.
    val yaml =
      """
      name: abba-with-membership-error
      devices: [A, B]
      steps:
        - { tool: barrier, params: { device: A, lock: X, deviceCount: 2 } }
        - { tool: barrier, params: { device: A, lock: Y, deviceCount: 2 } }
        - { tool: barrier, params: { device: B, lock: Y, deviceCount: 2 } }
        - { tool: barrier, params: { device: B, lock: X, deviceCount: 2 } }
        - { tool: barrier, params: { device: C, lock: Z, deviceCount: 1 } }
      """
        .trimIndent()
    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.errors.isNotEmpty())
    assertTrue(result.errors.none { it.message.contains("coordination can never complete") })
  }

  @Test
  fun `inline coordination fields are resolved like params`() {
    val yaml =
      """
      name: inline-abba
      devices: [A, B]
      steps:
        - { tool: barrier, device: A, lock: X, deviceCount: 2 }
        - { tool: barrier, device: A, lock: Y, deviceCount: 2 }
        - { tool: barrier, device: B, lock: Y, deviceCount: 2 }
        - { tool: barrier, device: B, lock: X, deviceCount: 2 }
      """
        .trimIndent()
    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.errors.any { it.message.contains("coordination can never complete") },
      "${result.errors}",
    )
  }

  private fun ev(lock: String, stepIndex: Int, unmodeled: Boolean = false) =
    CoordinationScheduleFeasibility.Event("barrier", lock, 2, stepIndex, unmodeled)

  private val abba =
    listOf(
      CoordinationScheduleFeasibility.Track("A", listOf(ev("X", 0), ev("Y", 1))),
      CoordinationScheduleFeasibility.Track("B", listOf(ev("Y", 2), ev("X", 3))),
    )

  @Test
  fun `returns null (unknown, accept) when the state budget is exhausted`() {
    assertNull(CoordinationScheduleFeasibility.findUnavoidableDeadlock(abba, maxStates = 1))
  }

  @Test
  fun `reports the stalled devices for an unavoidable deadlock`() {
    val deadlock = assertNotNull(CoordinationScheduleFeasibility.findUnavoidableDeadlock(abba))
    assertEquals(
      listOf("A" to "X", "B" to "Y"),
      deadlock.stalled.map { it.device to it.event.lock },
    )
    assertEquals(emptyList(), deadlock.finished)
  }

  @Test
  fun `splitIndependentComponents groups tracks that share a lock`() {
    val tracks =
      abba +
        listOf(
          CoordinationScheduleFeasibility.Track("C", listOf(ev("Z", 4))),
          CoordinationScheduleFeasibility.Track("D", listOf(ev("Z", 5), ev("W", 6))),
          CoordinationScheduleFeasibility.Track("E", listOf(ev("W", 7))),
        )
    val components = CoordinationScheduleFeasibility.splitIndependentComponents(tracks)
    assertEquals(
      listOf(listOf("A", "B"), listOf("C", "D", "E")),
      components.map { component -> component.map { it.device }.sorted() },
    )
  }

  @Test
  fun `skips only the component containing an unmodeled event`() {
    val tainted =
      listOf(
        CoordinationScheduleFeasibility.Track(
          "A",
          listOf(ev("X", 0, unmodeled = true), ev("Y", 1)),
        ),
        CoordinationScheduleFeasibility.Track("B", listOf(ev("Y", 2), ev("X", 3))),
      )
    assertNull(CoordinationScheduleFeasibility.findUnavoidableDeadlock(tainted))
    val independent =
      listOf(
        CoordinationScheduleFeasibility.Track("C", listOf(ev("Z", 4, unmodeled = true))),
        CoordinationScheduleFeasibility.Track("D", listOf(ev("Z", 5))),
      ) + abba
    val deadlock =
      assertNotNull(CoordinationScheduleFeasibility.findUnavoidableDeadlock(independent))
    assertEquals(listOf("A", "B"), deadlock.stalled.map { it.device })
  }

  @Test
  fun `returns null when there are no coordination events`() {
    assertNull(
      CoordinationScheduleFeasibility.findUnavoidableDeadlock(
        listOf(CoordinationScheduleFeasibility.Track("A", emptyList())),
      ),
    )
  }

  private companion object {
    private const val RELATIVE_FIXTURE = "test/fixtures/plan-schedule-feasibility/cases.json"

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
