package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorDeprecationTest {
  @Test
  fun `allows deprecated generated field with warning`() {
    val yaml =
      """
      name: legacy-plan
      generated: "2026-01-08T00:00:00Z"
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("generated") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'generated' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated appId field with warning`() {
    val yaml =
      """
      name: legacy-plan
      appId: com.example.app
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("appId") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'appId' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated parameters field with warning`() {
    val yaml =
      """
      name: legacy-plan
      parameters:
        key1: value1
        key2: value2
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("parameters") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'parameters' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated description in steps with warning`() {
    val yaml =
      """
      name: legacy-plan
      steps:
        - tool: observe
          description: Old-style description
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("description") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated step 'description' should be valid or have warning",
    )
  }

  @Test
  fun `type error on a deprecated-named field stays an error`() {
    val yaml =
      """
      name: login
      description:
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    val error = result.errors.single { it.field == "description" }
    assertEquals(ValidationSeverity.ERROR, error.severity)
  }
}
