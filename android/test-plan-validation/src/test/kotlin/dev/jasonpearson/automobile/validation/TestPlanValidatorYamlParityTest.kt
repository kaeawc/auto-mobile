package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Verdicts the daemon's validator gives the same YAML (#10129, #10131). The TypeScript twins of the
 * first three live in `test/utils/plan/planYamlScalars.test.ts`.
 */
class TestPlanValidatorYamlParityTest {
  private val unquotedPlan =
    """
    name: clock-plan
    metadata:
      createdAt: 2026-01-08T00:00:00Z
    steps:
      - tool: setDeviceState
        clock:
          mode: set
          instant: 2026-03-01T09:00:00Z
      - tool: observe
        label: yes
    """
      .trimIndent()

  @Test
  fun `unquoted timestamps and yes label are valid like the daemon`() {
    val result = TestPlanValidator.validateYaml(unquotedPlan)
    assertEquals(emptyList(), result.errors)
    assertTrue(result.valid)
  }

  @Test
  fun `an unquoted out-of-window instant reports the window error and no Date text`() {
    val result =
      TestPlanValidator.validateYaml(
        unquotedPlan.replace("2026-03-01T09:00:00Z", "1999-01-01T00:00:00Z")
      )
    assertFalse(result.valid)
    assertEquals(listOf("steps[0].clock.instant"), result.errors.map { it.field })
    assertTrue(result.errors.single().message.startsWith("Clock instant must be within"))
  }

  @Test
  fun `unquoted yes stays a string for a string-typed field`() {
    val result =
      TestPlanValidator.validateYaml("name: p\nsteps:\n  - tool: observe\n    label: no\n")
    assertTrue(result.valid, result.errors.toString())
  }

  // ===== #10131: a violation that invalidates the plan is an ERROR with its field =====

  private fun errorFields(yaml: String): List<String> =
    TestPlanValidator.validateYaml(yaml)
      .also { assertFalse(it.valid, "plan should be invalid") }
      .errors
      .filter { it.severity == ValidationSeverity.ERROR }
      .map { it.field }

  @Test
  fun `an empty description is an error naming description`() {
    val result =
      TestPlanValidator.validateYaml(
        "name: login\ndescription:\nsteps:\n  - tool: launchApp\n    appId: com.example.app\n"
      )
    assertFalse(result.valid)
    assertEquals(listOf("description"), result.errors.map { it.field })
    assertEquals(ValidationSeverity.ERROR, result.errors.single().severity)
  }

  @Test
  fun `type and format errors on formerly downgraded fields are errors`() {
    val prefix = "name: p\nsteps:\n  - tool: observe\n"
    assertEquals(listOf("parameters"), errorFields("parameters: [user, pass]\n$prefix"))
    assertEquals(listOf("generated"), errorFields("generated: yesterday\n$prefix"))
    assertEquals(listOf("appId"), errorFields("appId: 5\n$prefix"))
    assertEquals(
      listOf("steps[0].description"),
      errorFields("name: p\nsteps:\n  - tool: observe\n    description: 5\n"),
    )
  }

  @Test
  fun `a result is never invalid with an empty error list`() {
    val warning = ValidationError("generated", "deprecated", ValidationSeverity.WARNING)
    val error = ValidationError("name", "bad", ValidationSeverity.ERROR)
    assertTrue(TestPlanValidator.resultFor(listOf(warning)).valid)
    assertTrue(TestPlanValidator.resultFor(emptyList()).valid)
    assertFalse(TestPlanValidator.resultFor(listOf(warning, error)).valid)
    assertFalse(TestPlanValidator.resultFor(listOf(error)).valid)
  }

  @Test
  fun `only an additionalProperties notice on a deprecated field in place is a warning`() {
    val notice = "additionalProperties"
    assertTrue(TestPlanValidator.isDeprecatedFieldNotice("root", notice, "generated"))
    assertTrue(TestPlanValidator.isDeprecatedFieldNotice("root", notice, "appId"))
    assertTrue(TestPlanValidator.isDeprecatedFieldNotice("root", notice, "parameters"))
    assertTrue(TestPlanValidator.isDeprecatedFieldNotice("steps[2]", notice, "description"))
    // Current fields are never notices, nor is a different keyword on a deprecated one.
    assertFalse(TestPlanValidator.isDeprecatedFieldNotice("root", notice, "description"))
    assertFalse(TestPlanValidator.isDeprecatedFieldNotice("steps[0]", notice, "appId"))
    assertFalse(TestPlanValidator.isDeprecatedFieldNotice("root", "type", "generated"))
    assertFalse(TestPlanValidator.isDeprecatedFieldNotice("root", notice, null))
    assertFalse(TestPlanValidator.isDeprecatedFieldNotice("metadata", notice, "generated"))
  }

  @Test
  fun `deprecated fields with valid values stay accepted`() {
    val result =
      TestPlanValidator.validateYaml(
        "name: p\ndescription: ok\ngenerated: \"2026-01-08T00:00:00Z\"\nappId: com.example\n" +
          "parameters:\n  user: a\nsteps:\n  - tool: observe\n    description: old\n"
      )
    assertTrue(result.valid, result.errors.toString())
  }
}
