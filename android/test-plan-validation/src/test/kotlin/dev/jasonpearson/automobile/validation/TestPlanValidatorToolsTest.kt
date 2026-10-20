package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TestPlanValidatorToolsTest {
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

    val result = TestPlanValidator.validateYaml(validToolNamesYaml)
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

  private val validToolNamesYaml =
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
      - tool: putAppFile
        params:
          target:
            domain: user_files
            namespace: fixtures
          files:
            - destinationPath: fixture.txt
              contentText: fixture
      - tool: deleteDevice
    """
      .trimIndent()
}
