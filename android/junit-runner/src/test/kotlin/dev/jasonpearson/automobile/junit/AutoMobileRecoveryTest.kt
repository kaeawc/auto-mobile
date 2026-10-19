package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

internal class AutoMobileRecoveryTest : AutoMobileAgentTestFixture() {
  @Test
  fun `attemptAiRecovery returns success when agent completes and observe succeeds`() {
    // Arrange
    val context =
      FailedStepContext(
        failedStepIndex = 2,
        failedTool = "tapOn",
        error = "Element not found",
        succeededSteps =
          listOf(
            SucceededStepSummary(0, "observe"),
            SucceededStepSummary(1, "tapOn"),
          ),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val startTime = 1000L
    val endTime = 2000L
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(startTime, endTime))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""

    fakeAIAgent.response = "Recovery actions taken"

    // Act
    val result = autoMobileAgent.attemptAiRecovery(context)

    // Assert
    assertTrue(result.success)
    assertEquals(1000L, result.recoveryTimeMs)
    assertTrue(result.observeResultAfterRecovery != null)
    assertEquals(1, fakeAIAgent.prompts.size)
    assertEquals(listOf("http://localhost:3000"), fakeMcpClient.connectionUrls)
    assertEquals(5, fakeAiAgentFactory.recoveryCalls.single().maxToolCalls)
    // The agent's tools, WaitForTool and the liveness observe all target the failed device
    // (#10089): with two devices attached an unpinned call is rejected or hits the wrong one.
    assertTrue(fakeAiAgentFactory.recoveryCalls.single().mcpClient is DevicePinningMCPClient)
    assertTrue(fakeAiAgentFactory.recoveryCalls.single().rawMcpClient is DevicePinningMCPClient)
    assertEquals(
      1,
      fakeMcpClient.toolCalls.count {
        it == ("observe" to mapOf("deviceId" to "emulator-5554"))
      },
    )
  }

  private val recoveryContext =
    FailedStepContext(
      failedStepIndex = 1,
      failedTool = "tapOn",
      error = "Element not found",
      succeededSteps = emptyList(),
      planContent = "name: test\nsteps: []",
      deviceId = null,
    )

  @Test
  fun `a liveness observe that returns an isError result is not a live device`() {
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    fakeTimeProvider.times = ArrayDeque(listOf(1000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] =
      """{"isError":true,"content":[{"type":"text","text":"Unrecognized key(s) in object"}]}"""
    fakeAIAgent.response = "done"

    val result = autoMobileAgent.attemptAiRecovery(recoveryContext)

    assertFalse(result.success, "an isError tool result must not count as a responsive device")
  }

  @Test
  fun `a liveness observe that returns a non-error result is a live device`() {
    assertFalse(isToolErrorResult("""{"isError":false,"content":[]}"""))
    assertFalse(isToolErrorResult("""{"content":[{"type":"text","text":"isError"}]}"""))
    assertFalse(isToolErrorResult("plain text mentioning isError"))
  }

  @Test
  fun `an unreachable daemon fails recovery loudly with an actionable stderr message`() {
    fakeTimeProvider.times = ArrayDeque(listOf(1000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeMcpClient.connectFailure = RuntimeException("daemon is not reachable")

    val originalErr = System.err
    val captured = java.io.ByteArrayOutputStream()
    System.setErr(java.io.PrintStream(captured, true))
    val result =
      try {
        autoMobileAgent.attemptAiRecovery(recoveryContext)
      } finally {
        System.setErr(originalErr)
      }

    assertFalse(result.success)
    val message = captured.toString()
    assertTrue(message.contains("AI-assisted recovery could not start"), message)
    assertTrue(message.contains("daemon is not reachable"), message)
    assertEquals(0, fakeAiAgentFactory.recoveryCalls.size)
  }

  @Test
  fun `attemptAiRecovery prompt tells agent to clear the interruption, not perform the failed step`() {
    // Arrange
    val context =
      FailedStepContext(
        failedStepIndex = 2,
        failedTool = "tapOn",
        error = "Element not found",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    // A known deviceId pins the clients handed to the agent (#10089).
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""
    fakeAIAgent.response = "Dismissed the dialog"

    // Act
    autoMobileAgent.attemptAiRecovery(context)

    // Assert - the prompt must steer the agent toward clearing the blocker and away from
    // performing the failed step itself (the runner re-runs that step deterministically).
    val prompt = fakeAIAgent.prompts.single()
    assertTrue(
      prompt.contains("RE-RUN", ignoreCase = true),
      "Prompt should say the runner re-runs the failed step",
    )
    assertTrue(
      prompt.contains("Do NOT perform the failed step", ignoreCase = true),
      "Prompt should tell the agent not to perform the failed step's action",
    )
    assertTrue(
      prompt.contains("dismiss", ignoreCase = true),
      "Prompt should mention dismissing blockers like dialogs/notifications",
    )
  }

  @Test
  fun `recoveryIterationCap allows the full tool-call budget plus one concluding turn`() {
    // N tool calls need N+1 Koog iterations (the last iteration is the finishing
    // assistant turn), so the hard cap is maxToolCalls + 1.
    assertEquals(6, recoveryIterationCap(5))
    assertEquals(11, recoveryIterationCap(10))
  }

  @Test
  fun `recoveryIterationCap floors a non-positive budget so the agent can still observe`() {
    // A misconfigured 0 / negative budget must not produce a zero or negative cap that
    // aborts before the agent observes — it floors to 1 tool call (+1 => 2 iterations).
    assertEquals(2, recoveryIterationCap(0))
    assertEquals(2, recoveryIterationCap(-3))
    assertEquals(2, recoveryIterationCap(1))
  }

  @Test
  fun `attemptAiRecovery returns failure when agent throws exception`() {
    // Arrange
    val context =
      FailedStepContext(
        failedStepIndex = 0,
        failedTool = "tapOn",
        error = "Element not found",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = null,
      )
    val startTime = 1000L
    val endTime = 2000L
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(startTime, endTime))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig

    fakeAIAgent.failure = RuntimeException("AI failed")

    // Act
    val result = autoMobileAgent.attemptAiRecovery(context)

    // Assert
    assertFalse(result.success)
    assertEquals(1000L, result.recoveryTimeMs)
  }

  @Test
  fun `attemptAiRecovery returns failure when config provider throws exception`() {
    // Arrange
    val context =
      FailedStepContext(
        failedStepIndex = 0,
        failedTool = "tapOn",
        error = "Element not found",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = null,
      )
    val startTime = 1000L
    val endTime = 2000L

    fakeTimeProvider.times = ArrayDeque(listOf(startTime, endTime))
    fakeConfigProvider.serverUrlFailure = RuntimeException("Config error")

    // Act
    val result = autoMobileAgent.attemptAiRecovery(context)

    // Assert
    assertFalse(result.success)
    assertEquals(1000L, result.recoveryTimeMs)
  }

  @Test
  fun `attemptAiRecovery uses recoveryConfigProvider for max tool calls`() {
    // Arrange
    val customMaxToolCalls = 10
    val customAgent =
      AutoMobileAgent(
        configProvider = fakeConfigProvider,
        fileSystemOperations = fakeFileSystemOperations,
        aiAgentFactory = fakeAiAgentFactory,
        timeProvider = fakeTimeProvider,
        mcpClient = fakeMcpClient,
        recoveryConfigProvider = StaticRecoveryConfigProvider(maxToolCalls = customMaxToolCalls),
      )
    val context =
      FailedStepContext(
        failedStepIndex = 0,
        failedTool = "tapOn",
        error = "Element not found",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = null,
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""

    fakeAIAgent.response = "Done"

    // Act
    customAgent.attemptAiRecovery(context)

    // Assert - verify factory was called with the custom max tool calls
    assertTrue(
      FakeAgentAIAgentFactory.RecoveryCall(
        modelConfig,
        fakeMcpClient,
        customMaxToolCalls,
        fakeMcpClient,
      ) in fakeAiAgentFactory.recoveryCalls,
    )
  }
}
