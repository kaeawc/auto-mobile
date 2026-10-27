package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorYamlTest {
  @Test
  fun `core schema keeps timestamps and YAML 1_1 boolean words as strings`() {
    for (quoted in listOf(false, true)) {
      for (label in listOf("yes", "no", "on", "off", "YES", "ON")) {
        val instant = "2026-03-01T09:00:00Z"
        val createdAt = "2026-01-08T00:00:00Z"
        val yaml =
          """
          name: clock-plan
          generated: ${if (quoted) "\"$createdAt\"" else createdAt}
          metadata:
            createdAt: ${if (quoted) "\"$createdAt\"" else createdAt}
          steps:
            - tool: setDeviceState
              clock:
                mode: set
                instant: ${if (quoted) "\"$instant\"" else instant}
            - tool: observe
              label: ${if (quoted) "\"$label\"" else label}
          """
            .trimIndent()
        val result = TestPlanValidator.validateYaml(yaml)
        assertTrue(result.valid, "quoted=$quoted label=$label: ${result.errors}")
      }
    }
  }

  @Test
  fun `core schema preserves scalar types and merge keys`() {
    for (number in listOf("01000", "0o1750", "0x3e8", "1e3", "1000.0")) {
      val result =
        TestPlanValidator.validateYaml(
          """
        name: scalar-plan
        metadata:
          generatedFromToolCalls: true
          duration: 1.5e2
        steps:
          - &state
            tool: setDeviceState
            connectivity: {airplaneMode: false, wifiEnabled: TRUE}
          - <<: *state
            clock: {mode: advance, byMs: $number}
          - tool: observe
            label: "true"
        """
            .trimIndent(),
        )
      assertTrue(result.valid, "$number: ${result.errors}")
    }
    for (text in listOf("0b10", "1_000", "1:20", "-0x10", "+0o10")) {
      val result =
        TestPlanValidator.validateYaml("name: scalar-plan\nsteps: [{tool: observe, label: $text}]")
      assertTrue(result.valid, "$text: ${result.errors}")
    }
    for (value in listOf("null", "Null", "NULL", "~", "", "true", "false")) {
      assertFalse(
        TestPlanValidator.validateYaml("name: $value\nsteps: [{tool: observe}]").valid,
        "$value must not become a string",
      )
    }
    for (value in listOf("null", "Null", "NULL", "~", "", "true", "false", "\"1000\"")) {
      val result =
        TestPlanValidator.validateYaml(
          "name: scalar-plan\nsteps: [{tool: setDeviceState, clock: {mode: advance, byMs: $value}}]",
        )
      assertFalse(result.valid, "$value must not become a number")
    }
  }

  @Test
  fun `validates plan with YAML anchors`() {
    val yaml =
      """
      name: anchors-test
      description: Test with YAML anchors
      steps:
        - tool: launchApp
          params: &launch-params
            appId: com.example.app
            coldBoot: false
          label: First launch
        - tool: launchApp
          params:
            <<: *launch-params
            coldBoot: true
          label: Second launch with cold boot
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with YAML anchors should be valid")
  }

  @Test
  fun `validates plan with merge keys`() {
    val yaml =
      """
      name: merge-keys-test
      devices:
        - A
        - B
      steps:
        - tool: observe
          params: &observe-base
            includeScreenshot: true
            includeHierarchy: true
            device: A
        - tool: observe
          params:
            <<: *observe-base
            device: B
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with merge keys should be valid")
  }

  @Test
  fun `reports YAML parse errors`() {
    val yaml =
      """
      name: test
      steps: [invalid
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Invalid YAML should not be valid")
    assertTrue(result.errors.isNotEmpty(), "Should have errors")
    assertEquals("root", result.errors[0].field)
    assertTrue(result.errors[0].message.contains("YAML parsing failed"))
  }
}
