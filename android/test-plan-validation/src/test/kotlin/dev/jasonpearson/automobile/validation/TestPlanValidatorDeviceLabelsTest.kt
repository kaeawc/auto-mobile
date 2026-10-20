package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorDeviceLabelsTest {
  @Test
  fun `accepts devices that are all label platform definitions`() {
    val yaml =
      """
      name: all-definition-devices
      devices:
        - label: A
          platform: android
        - label: B
          platform: ios
      steps:
        - tool: tapOn
          params:
            device: A
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "All label/platform device definitions should be valid")
  }

  @Test
  fun `rejects two structurally-different device definitions sharing a label`() {
    // JSON Schema's uniqueItems only compares whole entries, so an Android
    // "A" and an iOS "A" definition pass it -- but they collapse to the
    // same label, and the daemon's validateDevicesField rejects the
    // duplicate regardless of the definitions' other fields (#6215 review).
    val yaml =
      """
      name: duplicate-label-across-definitions
      devices:
        - label: A
          platform: android
        - label: A
          platform: ios
      steps:
        - tool: tapOn
          params:
            device: A
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Two structurally-different device definitions sharing a label should be invalid",
    )
  }

  @Test
  fun `rejects a non-coordination step's params device when it is not a string`() {
    // For a tool with no tool-specific params schema (e.g. tapOn), an
    // invalid inline device is skipped once params declares device (params
    // wins at normalization), but nothing previously validated params.device
    // itself -- a plan with params.device: 456 would normalize to an
    // invalid device and only fail at the daemon (#6215 review).
    val yaml =
      """
      name: tapon-invalid-params-device-number
      devices:
        - A
      steps:
        - tool: tapOn
          device: 123
          params:
            device: 456
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A non-string params.device should be invalid")
  }

  @Test
  fun `rejects a non-coordination step's params device when it is whitespace-only`() {
    val yaml =
      """
      name: tapon-blank-params-device
      devices:
        - A
      steps:
        - tool: tapOn
          params:
            device: " "
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A whitespace-only params.device should be invalid")
  }

  @Test
  fun `accepts a valid params device overriding an invalid inline device`() {
    val yaml =
      """
      name: tapon-valid-params-device
      devices:
        - A
      steps:
        - tool: tapOn
          device: 123
          params:
            device: A
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "A valid params.device overriding an invalid inline device should be valid",
    )
  }

  @Test
  fun `rejects a single device arriving more times than there are generations`() {
    // A, B, A, A with deviceCount=2: 4 arrivals is divisible by 2 (G=2), but
    // device A appears 3 times (greater than G=2) -- after generation 1
    // {A,B} releases, A's second arrival starts generation 2, but its third
    // arrival has no generation left to join.
    val yaml =
      """
      name: barrier-excess-single-device-arrivals
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
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Device A arriving 3 times with only 2 generations available should be invalid",
    )
  }

  @Test
  fun `rejects devices mixing a plain-string label with a label platform definition`() {
    val yaml =
      """
      name: mixed-device-formats
      devices:
        - A
        - label: B
          platform: android
      steps:
        - tool: tapOn
          params:
            device: A
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Mixed device declaration formats should be invalid")
  }

  @Test
  fun `accepts devices that are all plain-string labels`() {
    val yaml =
      """
      name: all-label-devices
      devices:
        - A
        - B
      steps:
        - tool: tapOn
          params:
            device: A
            text: hi
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "All plain-string device labels should be valid")
  }

  @Test
  fun `rejects an invalid inline device when params is null`() {
    // JSON Schema's "required" keyword vacuously passes against a
    // non-object value, so a naive "params has device" guard would treat
    // params: null as if it declared 'device', wrongly skipping the inline
    // check. The guard must require params to be an object before
    // trusting its presence (#6215 review).
    val yaml =
      """
      name: tapon-null-params-invalid-device
      devices:
        - A
      steps:
        - tool: tapOn
          device: 123
          params: null
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An invalid inline device with params: null should be invalid")
  }

  @Test
  fun `accepts a valid inline device when params is null`() {
    val yaml =
      """
      name: tapon-null-params-valid-device
      devices:
        - A
      steps:
        - tool: tapOn
          device: A
          params: null
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "A valid inline device with params: null should be valid")
  }

  @Test
  fun `rejects a whitespace-only declared device label`() {
    // A whitespace-only label like " " satisfies the schema's minLength:1
    // (and now the non-whitespace pattern too), but the daemon trims
    // labels before checking emptiness -- mirrors
    // PlanValidator.validateDevicesField (#6215 review).
    val yaml =
      """
      name: whitespace-only-device-label
      devices:
        - " "
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A whitespace-only device label should be invalid")
  }

  @Test
  fun `reports duplicate devices`() {
    val yaml =
      """
      name: test-plan
      devices:
        - A
        - A
      steps:
        - tool: observe
          params:
            device: A
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("devices") })
  }

  @Test
  fun `reports empty device label`() {
    val yaml =
      """
      name: test-plan
      devices:
        - ""
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("devices") })
  }
}
