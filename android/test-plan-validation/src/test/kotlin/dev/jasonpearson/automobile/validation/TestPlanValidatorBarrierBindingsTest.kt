package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorBarrierBindingsTest {
  @Test
  fun `rejects a barrier with an inline malformed platform value`() {
    // The inline form must be constrained the same as the nested-params
    // form, or PlanNormalizer moving it into params later would make the
    // runtime addDeviceTargetingToSchema reject a plan this authoring
    // schema accepted (#6215 review).
    val yaml =
      """
      name: barrier-inline-malformed-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          platform: windows
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An inline platform=windows should be invalid")
  }

  @Test
  fun `accepts a barrier with an inline valid platform value`() {
    val yaml =
      """
      name: barrier-inline-valid-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          platform: android
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "An inline platform=android should be valid")
  }

  @Test
  fun `accepts barrier with inline coordination params (no nested params object)`() {
    // Plans may place lock/deviceCount/device directly on the step, the same
    // inline-vs-params shape criticalSection (and most other tools) accept.
    val yaml =
      """
      name: barrier-inline-test
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Inline-form barrier plan should be valid")
  }

  @Test
  fun `accepts barrier with coordination fields split across inline and params`() {
    // PlanNormalizer merges inline fields and params together before
    // execution, so a field counts as present wherever it appears -- lock
    // inline + deviceCount in params must validate. A second device's
    // arrival is included so the lock's declared deviceCount=2 is
    // satisfiable by 2 distinct devices.
    val yaml =
      """
      name: barrier-split-fields-test
      devices:
        - A
        - B
      steps:
        - tool: barrier
          lock: sync-point
          params:
            device: A
            deviceCount: 2
        - tool: barrier
          lock: sync-point
          params:
            device: B
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Split-field barrier plan should be valid")
  }

  @Test
  fun `rejects barrier missing deviceCount from both inline and params`() {
    val yaml =
      """
      name: barrier-split-fields-missing-devicecount
      devices:
        - A
      steps:
        - tool: barrier
          lock: sync-point
          params:
            device: A
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing deviceCount from both locations should be invalid")
  }

  @Test
  fun `accepts an inline barrier with params null and valid inline lock deviceCount device`() {
    // PlanNormalizer.isRecord treats a non-object params (e.g. null) as
    // absent ({}), so an inline-form barrier step with params: null is a
    // previously-supported normalized form -- the unconditional
    // barrierParams $ref (which requires an object) must not reject it;
    // only the inline fields should be validated (#6215 review).
    val yaml =
      """
      name: barrier-inline-null-params
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync1
          deviceCount: 2
          params: null
        - tool: barrier
          device: B
          lock: sync1
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "An inline barrier with params: null and valid inline fields should be valid",
    )
  }

  @Test
  fun `rejects an inline barrier with params null and an invalid inline field`() {
    val yaml =
      """
      name: barrier-inline-null-params-invalid
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync1
          deviceCount: not-a-number
          params: null
        - tool: barrier
          device: B
          lock: sync1
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An invalid inline deviceCount with params: null should be invalid")
  }
}
