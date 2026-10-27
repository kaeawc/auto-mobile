package dev.jasonpearson.automobile.junit

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

internal class AutoMobileAgentTest : AutoMobileAgentTestFixture() {
  @Test
  fun `generatePlanFromPrompt creates new plan when file does not exist`() {
    // Arrange
    val prompt = "Test login functionality"
    val className = "LoginTest"
    val methodName = "testLogin"
    val expectedPlanPath = "test-plans/generated/LoginTest_testLogin.yaml"
    val generatedPlansDir = File(tempDir, "test-plans/generated")
    val planFile = File(generatedPlansDir, "LoginTest_testLogin.yaml")
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    val expectedYamlContent =
      """
      ---
      name: login-test
      description: Test login functionality
      steps:
        - tool: observe
          withViewHierarchy: true
          label: Initial observation
      """
        .trimIndent()

    fakeFileSystemOperations.fileExistence[planFile] = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeConfigProvider.debugMode = false

    fakeAIAgent.response =
      """
            ```yaml
            $expectedYamlContent
            ```
        """
        .trimIndent()

    // Act
    val result = autoMobileAgent.generatePlanFromPrompt(prompt, className, methodName, tempDir)

    // Assert
    assertEquals(expectedPlanPath, result)
    assertTrue(generatedPlansDir in fakeFileSystemOperations.createdDirectories)
    assertTrue(planFile in fakeFileSystemOperations.existenceChecks)
    assertTrue(fakeFileSystemOperations.writes.any { (file, _) -> file == planFile })
    assertTrue(fakeAIAgent.prompts.isNotEmpty())
  }

  @Test
  fun `generatePlanFromPrompt uses existing plan when file exists and is recent`() {
    // Arrange
    val prompt = "Test login functionality"
    val className = "LoginTest"
    val methodName = "testLogin"
    val expectedPlanPath = "test-plans/generated/LoginTest_testLogin.yaml"
    val generatedPlansDir = File(tempDir, "test-plans/generated")
    val planFile = File(generatedPlansDir, "LoginTest_testLogin.yaml")
    val currentTime = 1000L
    val fileTime = 500L
    val maxAge = 3600000L // 1 hour

    fakeFileSystemOperations.fileExistence[planFile] = true
    fakeTimeProvider.times = ArrayDeque(listOf(currentTime))
    fakeFileSystemOperations.lastModified[planFile] = fileTime
    fakeConfigProvider.maxPlanAgeMs = maxAge

    // Act
    val result = autoMobileAgent.generatePlanFromPrompt(prompt, className, methodName, tempDir)

    // Assert
    assertEquals(expectedPlanPath, result)
    assertTrue(generatedPlansDir in fakeFileSystemOperations.createdDirectories)
    assertTrue(planFile in fakeFileSystemOperations.existenceChecks)
    assertTrue(fakeFileSystemOperations.writes.isEmpty())
    assertTrue(fakeAiAgentFactory.planCalls.isEmpty())
    assertEquals(0, fakeAIAgent.prompts.size)
  }

  @Test
  fun `generatePlanFromPrompt regenerates plan when file is old`() {
    // Arrange
    val prompt = "Test login functionality"
    val className = "LoginTest"
    val methodName = "testLogin"
    val generatedPlansDir = File(tempDir, "test-plans/generated")
    val planFile = File(generatedPlansDir, "LoginTest_testLogin.yaml")
    val currentTime = 4000000L
    val fileTime = 500L
    val maxAge = 3600000L // 1 hour
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    val yamlContent = "---\nname: test\nsteps: []"

    fakeFileSystemOperations.fileExistence[planFile] = true
    fakeTimeProvider.times = ArrayDeque(listOf(currentTime, fileTime))
    fakeFileSystemOperations.lastModified[planFile] = fileTime
    fakeConfigProvider.maxPlanAgeMs = maxAge
    fakeConfigProvider.configuredModel = modelConfig
    fakeConfigProvider.debugMode = false

    fakeAIAgent.response = "```yaml\n$yamlContent\n```"

    // Act
    autoMobileAgent.generatePlanFromPrompt(prompt, className, methodName, tempDir)

    // Assert
    assertTrue((planFile to yamlContent) in fakeFileSystemOperations.writes)
    assertTrue(fakeAIAgent.prompts.isNotEmpty())
  }

  @Test
  fun `generatePlanFromPrompt throws exception when AI agent fails`() {
    // Arrange
    val prompt = "Test login functionality"
    val className = "LoginTest"
    val methodName = "testLogin"
    val generatedPlansDir = File(tempDir, "test-plans/generated")
    val planFile = File(generatedPlansDir, "LoginTest_testLogin.yaml")
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeFileSystemOperations.fileExistence[planFile] = false
    fakeConfigProvider.configuredModel = modelConfig

    fakeAIAgent.failure = RuntimeException("AI agent failed")

    // Act & Assert
    val exception =
      assertThrows<RuntimeException> {
        autoMobileAgent.generatePlanFromPrompt(prompt, className, methodName, tempDir)
      }
    assertTrue(exception.message!!.contains("Failed to generate YAML plan from prompt"))
  }

  @Test
  fun `extractYamlFromResponse extracts YAML from code blocks`() {
    // Arrange
    val agent = AutoMobileAgent()
    val response =
      """
      Here's your YAML plan:
      ```yaml
      ---
      name: test-plan
      description: A test plan
      steps:
        - tool: observe
      ```
      That should work!
      """
        .trimIndent()

    // Act - using reflection to access private method for testing
    val method =
      AutoMobileAgent::class.java.getDeclaredMethod("extractYamlFromResponse", String::class.java)
    method.isAccessible = true
    val result = method.invoke(agent, response) as String

    // Assert
    val expectedYaml =
      """
      ---
      name: test-plan
      description: A test plan
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(expectedYaml, result)
  }

  @Test
  fun `extractYamlFromResponse extracts YAML starting with triple dashes`() {
    // Arrange
    val agent = AutoMobileAgent()
    val response =
      """
      Here's your plan:

      ---
      name: test-plan
      description: A test plan
      steps:
        - tool: observe
      """
        .trimIndent()

    // Act
    val method =
      AutoMobileAgent::class.java.getDeclaredMethod("extractYamlFromResponse", String::class.java)
    method.isAccessible = true
    val result = method.invoke(agent, response) as String

    // Assert
    val expectedYaml =
      """
      ---
      name: test-plan
      description: A test plan
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(expectedYaml, result)
  }

  @Test
  fun `extractYamlFromResponse returns entire response if it looks like YAML`() {
    // Arrange
    val agent = AutoMobileAgent()
    val response =
      """
      name: test-plan
      description: A test plan
      steps:
        - tool: observe
      """
        .trimIndent()

    // Act
    val method =
      AutoMobileAgent::class.java.getDeclaredMethod("extractYamlFromResponse", String::class.java)
    method.isAccessible = true
    val result = method.invoke(agent, response) as String

    // Assert
    assertEquals(response, result)
  }

  @Test
  fun `extractYamlFromResponse returns empty string for invalid content`() {
    // Arrange
    val agent = AutoMobileAgent()
    val response = "This is just regular text without YAML structure"

    // Act
    val method =
      AutoMobileAgent::class.java.getDeclaredMethod("extractYamlFromResponse", String::class.java)
    method.isAccessible = true
    val result = method.invoke(agent, response) as String

    // Assert
    assertEquals("", result)
  }

  @Test
  fun `extractYamlFromResponse handles null input`() {
    // Arrange
    val agent = AutoMobileAgent()

    // Act
    val method =
      AutoMobileAgent::class.java.getDeclaredMethod("extractYamlFromResponse", String::class.java)
    method.isAccessible = true
    val result = method.invoke(agent, null) as String

    // Assert
    assertEquals("", result)
  }
}
