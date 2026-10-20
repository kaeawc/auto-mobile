package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TestPlanValidatorTest {
  @Test
  fun `invalid result always carries an error-severity entry`() {
    val yaml =
      """
      name: login
      parameters: [user, pass]
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.severity == ValidationSeverity.ERROR })
  }

  @Test
  fun `validates minimal valid plan`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan should be valid")
    assertTrue(result.errors.isEmpty(), "Should have no errors")
  }

  @Test
  fun `validates complete plan with all fields`() {
    val yaml =
      """
      name: complete-plan
      description: A complete test plan
      devices:
        - A
        - B
      steps:
        - tool: launchApp
          params:
            appId: com.example.app
          device: A
          label: Launch app on device A
        - tool: observe
          params:
            device: A
      metadata:
        createdAt: "2026-01-08T00:00:00Z"
        version: "1.0.0"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Complete plan should be valid")
  }

  @Test
  fun `validates expectations array`() {
    val yaml =
      """
      name: expectations-test
      steps:
        - tool: observe
          expectations:
            - type: elementExists
              selector:
                text: "Hello"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with expectations should be valid")
  }

  @Test
  fun `validates metadata fields`() {
    val yaml =
      """
      name: metadata-test
      steps:
        - tool: observe
      metadata:
        createdAt: "2026-01-08T00:00:00Z"
        version: "1.0.0"
        appId: com.example.app
        sessionId: "session-123"
        toolCallCount: 10
        duration: 1500.5
        generatedFromToolCalls: true
        experiments: ["exp-1", "exp-2"]
        treatments:
          exp-1: "variant-a"
        featureFlags:
          darkMode: true
          beta: false
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with metadata should be valid")
  }

  @Test
  fun `reports missing required name field`() {
    val yaml =
      """
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.isNotEmpty())
    val nameError = result.errors.find { it.message.contains("name") }
    assertNotNull(nameError, "Should have error about missing name")
    assertTrue(nameError.message.contains("Missing required property"))
  }

  @Test
  fun `reports missing required steps field`() {
    val yaml =
      """
      name: test-plan
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    val stepsError = result.errors.find { it.message.contains("steps") }
    assertNotNull(stepsError, "Should have error about missing steps")
    assertTrue(stepsError.message.contains("Missing required property"))
  }

  @Test
  fun `reports empty name`() {
    val yaml =
      """
      name: ""
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("name") })
  }

  @Test
  fun `reports empty steps array`() {
    val yaml =
      """
      name: test-plan
      steps: []
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.message.contains("at least 1") })
  }

  @Test
  fun `reports missing tool in step`() {
    val yaml =
      """
      name: test-plan
      steps:
        - params:
            foo: bar
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    val toolError = result.errors.find { it.message.contains("tool") }
    assertNotNull(toolError, "Should have error about missing tool")
    assertTrue(toolError.message.contains("Missing required property"))
  }

  @Test
  fun `reports wrong type for steps`() {
    val yaml =
      """
      name: test-plan
      steps: "not an array"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Plan with wrong type for steps should be invalid")
    assertTrue(result.errors.isNotEmpty(), "Should have at least one error")
    val hasStepsError =
      result.errors.any { error ->
        error.field.contains("steps", ignoreCase = true) ||
          error.message.contains("steps", ignoreCase = true) ||
          error.message.contains("array", ignoreCase = true)
      }
    assertTrue(
      hasStepsError,
      "Should have error related to steps being wrong type. Errors: ${result.errors}",
    )
  }

  @Test
  fun `reports invalid mcpVersion format`() {
    val yaml =
      """
      name: test-plan
      mcpVersion: invalid-version
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("mcpVersion") })
  }

  @Test
  fun `detects unknown property as error`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
      unknownField: value
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with unknown property should fail validation")
    val unknownError = result.errors.find { it.message.contains("unknownField") }
    assertNotNull(unknownError, "Should report unknown property")
  }

  @Test
  fun `provides line numbers when possible`() {
    val invalidYaml =
      """
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(invalidYaml)
    assertFalse(result.valid)
    // Line numbers are best-effort, so we just verify the structure is correct
    result.errors.forEach { error ->
      assertNotNull(error.field)
      assertNotNull(error.message)
      // line and column may be null, which is acceptable
    }
  }

  @Test
  fun `formats field paths nicely`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
        - {}
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    // Should have error for steps[1] missing tool
    val error = result.errors.find { it.field.contains("steps") }
    assertNotNull(error, "Should have error about steps")
  }
}
