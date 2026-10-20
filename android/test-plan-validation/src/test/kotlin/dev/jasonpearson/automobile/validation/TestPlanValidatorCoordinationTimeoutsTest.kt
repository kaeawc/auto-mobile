package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorCoordinationTimeoutsTest {
  @Test
  fun `accepts barrier with a positive timeout`() {
    // Both A and B arrive so the declared deviceCount=2 is satisfiable by 2
    // distinct devices.
    val yaml =
      """
      name: barrier-positive-timeout
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            timeout: 5000
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
            timeout: 5000
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "barrier with a positive timeout should be valid")
  }

  @Test
  fun `rejects criticalSection with a zero timeout`() {
    val yaml =
      """
      name: critical-section-zero-timeout
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            lock: sync-point
            deviceCount: 1
            timeout: 0
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection with timeout=0 should be invalid")
  }

  @Test
  fun `rejects a barrier timeout exceeding setTimeout's usable range`() {
    val yaml =
      """
      name: barrier-timeout-over-cap
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync1
            deviceCount: 2
            timeout: 2147483648
        - tool: barrier
          params:
            device: B
            lock: sync1
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A barrier timeout exceeding setTimeout's usable range should be invalid",
    )
  }

  @Test
  fun `accepts a barrier timeout at exactly setTimeout's usable range`() {
    val yaml =
      """
      name: barrier-timeout-at-cap
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync1
            deviceCount: 2
            timeout: 2147483647
        - tool: barrier
          params:
            device: B
            lock: sync1
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "A barrier timeout at exactly setTimeout's usable range should be valid",
    )
  }

  @Test
  fun `rejects a criticalSection timeout exceeding setTimeout's usable range`() {
    val yaml =
      """
      name: critical-section-timeout-over-cap
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync1
            deviceCount: 1
            timeout: 2147483648
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: OK
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A criticalSection timeout exceeding setTimeout's usable range should be invalid",
    )
  }

  @Test
  fun `accepts a criticalSection timeout at exactly setTimeout's usable range`() {
    val yaml =
      """
      name: critical-section-timeout-at-cap
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync1
            deviceCount: 1
            timeout: 2147483647
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: OK
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "A criticalSection timeout at exactly setTimeout's usable range should be valid",
    )
  }

  @Test
  fun `rejects barrier with a zero timeout`() {
    val yaml =
      """
      name: barrier-zero-timeout
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            timeout: 0
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "barrier with timeout=0 should be invalid")
  }
}
