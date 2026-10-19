package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorBarrierParametersTest {
  @Test
  fun `validates barrier parameters`() {
    val yaml =
      """
      name: barrier-test
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
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Barrier plan should be valid")
  }

  @Test
  fun `rejects barrier missing lock`() {
    val yaml =
      """
      name: barrier-missing-lock
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing 'lock' should be invalid")
  }

  @Test
  fun `rejects barrier missing deviceCount`() {
    val yaml =
      """
      name: barrier-missing-devicecount
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing 'deviceCount' should be invalid")
  }

  @Test
  fun `rejects barrier with wrong-typed deviceCount`() {
    val yaml =
      """
      name: barrier-bad-devicecount-type
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: "two"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier with a non-numeric deviceCount should be invalid")
  }

  @Test
  fun `rejects barrier with a malformed platform value`() {
    // addDeviceTargetingToSchema restricts platform to android/ios at
    // execution; the authoring schema must reject an invalid value too,
    // instead of only failing at execution (#6215 review).
    val yaml =
      """
      name: barrier-malformed-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            platform: windows
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "barrier with platform=windows should be invalid")
  }

  @Test
  fun `accepts barrier with a valid platform value`() {
    val yaml =
      """
      name: barrier-valid-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            platform: android
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
            platform: android
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "barrier with platform=android should be valid")
  }
}
