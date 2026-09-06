package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TestPlanValidatorTest {

  // ========== Valid Plan Tests ==========

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
            lock: sync-point
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Critical section plan should be valid")
  }

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
    // inline + deviceCount in params must validate.
    val yaml =
      """
      name: barrier-split-fields-test
      devices:
        - A
      steps:
        - tool: barrier
          lock: sync-point
          params:
            device: A
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
  fun `accepts criticalSection with inline coordination params`() {
    val yaml =
      """
      name: critical-section-inline-test
      devices:
        - A
      steps:
        - tool: criticalSection
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

  @Test
  fun `accepts barrier with a positive timeout`() {
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

  // ========== YAML Parsing Tests ==========

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

  // ========== Required Field Tests ==========

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
  fun `reports empty tool name`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: ""
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("tool") })
  }

  // ========== Type Validation Tests ==========

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

  // ========== Field Validation Tests ==========

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

  // ========== Deprecated Field Tests ==========

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

  // ========== Tool Name Validation Tests ==========

  @Test
  fun `detects invalid tool name`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: invalidTool
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with invalid tool should fail validation")
    val toolError =
      result.errors.find {
        it.message.contains("Unknown tool") && it.message.contains("invalidTool")
      }
    assertNotNull(toolError, "Should report unknown tool")
  }

  @Test
  fun `accepts valid tool names`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
        - tool: tapOn
          params:
            text: button
        - tool: launchApp
          params:
            appId: com.example.app
        - tool: crashApp
          params:
            appId: com.example.app
        - tool: setAppPermissions
          params:
            appId: com.example.app
            permissions:
              - camera
        - tool: getAppPermissions
          params:
            appId: com.example.app
        - tool: getDeviceState
          params:
            include:
              - doNotDisturb
        - tool: setDeviceState
          params:
            doNotDisturb:
              mode: priority
        - tool: getNotificationPolicy
          params:
            appId: com.example.app
        - tool: setNotificationPolicy
          params:
            appId: com.example.app
            policyAccess: true
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: revoke
            permissions:
              - camera
        - tool: setAppPermissions
          params:
            appId: com.example.app
            notificationsEnabled: true
        - tool: getAppPermissions
          params:
            appId: com.example.app
            permissions:
              - camera
        - tool: provisionDevice
        - tool: stageSharedStorage
        - tool: deleteDevice
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "YAML with valid tools should pass validation: ${result.errors}")
  }

  @Test
  fun `rejects reset with userId`() {
    val yaml =
      """
      name: invalid-reset-user
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            permissions:
              - all
            userId: 10
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Android reset must reject userId: ${result.errors}")
  }

  @Test
  fun `rejects reset without permissions`() {
    val yaml =
      """
      name: invalid-reset-without-permissions
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            notificationsEnabled: false
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Reset must require permissions: ${result.errors}")
  }

  @Test
  fun `rejects Android reset without all permissions`() {
    val yaml =
      """
      name: invalid-android-reset-scope
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            platform: android
            permissions:
              - camera
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Android reset must require permissions=['all']: ${result.errors}")
  }

  @Test
  fun `accepts accessibilityFocus tool published in generated definitions`() {
    val yaml =
      """
      name: accessibility-focus-plan
      steps:
        - tool: accessibilityFocus
          params:
            resourceId: login_button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "accessibilityFocus should be accepted: ${result.errors}")
  }

  @Test
  fun `detects multiple invalid tool names`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: invalidTool1
        - tool: observe
        - tool: invalidTool2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with invalid tools should fail validation")
    val tool1Error = result.errors.find { it.message.contains("invalidTool1") }
    val tool2Error = result.errors.find { it.message.contains("invalidTool2") }
    assertNotNull(tool1Error, "Should report first invalid tool")
    assertNotNull(tool2Error, "Should report second invalid tool")
  }

  // ========== Tool Parameter Validation Tests ==========

  @Test
  fun `validates dragAndDrop params in params object`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
            target:
              elementId: target-id
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "dragAndDrop with valid params should be valid: ${result.errors}")
  }

  @Test
  fun `reports missing dragAndDrop target`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "dragAndDrop without target should be invalid")
    assertTrue(
      result.errors.any { error ->
        error.field.contains("target", ignoreCase = true) ||
          error.message.contains("target", ignoreCase = true)
      },
      "Should report missing target: ${result.errors}",
    )
  }

  @Test
  fun `reports dragAndDrop source with both text and elementId`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
              elementId: source-id
            target:
              text: Target
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "dragAndDrop source should require exactly one selector")
    assertTrue(
      result.errors.any { error ->
        error.field.contains("source", ignoreCase = true) ||
          error.message.contains("source", ignoreCase = true)
      },
      "Should report invalid source selector: ${result.errors}",
    )
  }

  @Test
  fun `validates dragAndDrop with top-level selectors and param overrides`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          source:
            text: Source
          target:
            text: Target
          params:
            dragDurationMs: 800
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "dragAndDrop with top-level selectors should be valid: ${result.errors}",
    )
  }

  // ========== Error Reporting Tests ==========

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
