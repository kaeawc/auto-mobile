package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorBarrierDevicesTest {
  @Test
  fun `rejects a barrier step's params device when it is whitespace-only`() {
    val yaml =
      """
      name: barrier-blank-params-device
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: " "
            lock: sync1
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync1
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A whitespace-only barrier params.device should be invalid")
  }

  @Test
  fun `rejects a barrier step that omits device entirely under a declared devices set`() {
    // devices=[A]: one deviceCount=1 barrier step for this lock omits
    // 'device' altogether while another targets A. The device-less step
    // must be rejected, not silently ignored -- mirrors the daemon's
    // PlanValidator.validateDeviceLabelsPresent.
    val yaml =
      """
      name: barrier-missing-device
      devices:
        - A
      steps:
        - tool: barrier
          params:
            lock: sync-point
            deviceCount: 1
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 1
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A barrier step with no device label should be invalid")
  }

  @Test
  fun `accepts barrier with invalid inline deviceCount overridden by a valid params deviceCount`() {
    // PlanNormalizer's params-wins merge discards the inline sibling, so the
    // effective (params) value is what must be validated.
    val yaml =
      """
      name: barrier-inline-invalid-params-valid
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: not-a-number
          params:
            deviceCount: 2
        - tool: barrier
          device: B
          lock: sync-point
          params:
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "Effective (params) deviceCount should be validated, not the discarded inline value",
    )
  }

  @Test
  fun `rejects barrier with a valid inline deviceCount overridden by an invalid params deviceCount`() {
    val yaml =
      """
      name: barrier-inline-valid-params-invalid
      devices:
        - A
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          params:
            deviceCount: 0
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Effective (params) deviceCount=0 should be rejected even though inline is valid",
    )
  }

  @Test
  fun `rejects a barrier plan with no top-level devices declaration`() {
    // Mirrors the daemon's PlanValidator.validateMultiDeviceRequirements: a
    // barrier step is a multi-device coordination primitive, so a plan using
    // it must declare 'devices'. Without this check, IDE/JUnit validation
    // would bless a plan the daemon rejects at load time (#6215 review).
    val yaml =
      """
      name: barrier-no-devices-declared
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier plan without a 'devices' declaration should be invalid")
  }

  @Test
  fun `rejects a barrier plan targeting device labels outside the declared devices set`() {
    // devices=[A,B] but the barrier steps target C/D: the distinct-device
    // count (2) would otherwise satisfy deviceCount=2, but C/D are not
    // declared devices at all, so this must be rejected regardless --
    // mirrors the daemon's PlanValidator.validateDeviceLabelsPresent.
    val yaml =
      """
      name: barrier-targets-undeclared-devices
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: C
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: D
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier targeting undeclared device labels should be invalid")
  }

  @Test
  fun `rejects a plan with valid barriers plus a device-less non-coordination step`() {
    // devices=[A,B] and both barrier steps are individually valid, but the
    // trailing tapOn step declares no device at all. The daemon's
    // PlanValidator.validateDeviceLabelsPresent checks every step
    // generically, not just barrier/criticalSection -- this must be
    // rejected here too (#6215 review).
    val yaml =
      """
      name: barrier-plan-with-device-less-tapon
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: tapOn
          params:
            text: Continue
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A device-less tapOn step under a plan that declares devices should be invalid",
    )
  }

  @Test
  fun `rejects a plan with valid barriers plus a non-coordination step targeting an undeclared device`() {
    val yaml =
      """
      name: barrier-plan-with-undeclared-device-tapon
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: tapOn
          params:
            device: C
            text: Continue
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A tapOn step targeting an undeclared device should be invalid",
    )
  }
}
