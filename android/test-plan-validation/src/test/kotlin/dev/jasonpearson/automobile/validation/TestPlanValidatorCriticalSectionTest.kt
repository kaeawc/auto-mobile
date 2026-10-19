package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorCriticalSectionTest {
  @Test
  fun `validates critical section parameters`() {
    val yaml =
      """
      name: critical-section-test
      devices:
        - A
        - B
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
        - tool: criticalSection
          params:
            device: B
            lock: sync-point
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: B
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Critical section plan should be valid")
  }

  @Test
  fun `rejects criticalSection missing lock`() {
    val yaml =
      """
      name: critical-section-missing-lock
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection missing 'lock' should be invalid")
  }

  @Test
  fun `rejects criticalSection missing deviceCount`() {
    val yaml =
      """
      name: critical-section-missing-devicecount
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            lock: sync-point
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection missing 'deviceCount' should be invalid")
  }

  @Test
  fun `accepts criticalSection with inline coordination params`() {
    val yaml =
      """
      name: critical-section-inline-test
      devices:
        - A
      steps:
        - tool: criticalSection
          device: A
          lock: sync-point
          deviceCount: 1
          steps:
            - tool: tapOn
              params:
                device: A
                text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Inline-form criticalSection plan should be valid")
  }

  @Test
  fun `accepts a criticalSection sub-step with a discarded invalid inline device overridden by a valid params device`() {
    // PlanNormalizer.normalizeSteps merges params over inline fields for
    // EVERY step, not just the outer criticalSection/barrier step -- a
    // nested sub-step is itself validated as a planStep (via the
    // criticalSectionParams.steps $ref), so this precedence must be
    // honored there too (#6215 review).
    val yaml =
      """
      name: critical-section-substep-device-override
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 1
            steps:
              - tool: tapOn
                device: 123
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "A discarded invalid inline device overridden by a valid params.device should be valid",
    )
  }

  @Test
  fun `rejects a criticalSection sub-step with an invalid inline device when params does not override it`() {
    val yaml =
      """
      name: critical-section-substep-invalid-device
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 1
            steps:
              - tool: tapOn
                device: 123
                params:
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An un-overridden invalid inline device should be invalid")
  }
}
