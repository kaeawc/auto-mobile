package dev.jasonpearson.automobile.junit

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir

class AutoMobileAgentTest {

  private lateinit var fakeConfigProvider: FakeAgentConfigProvider
  private lateinit var fakeFileSystemOperations: FakeAgentFileSystemOperations
  private lateinit var fakeAiAgentFactory: FakeAgentAIAgentFactory
  private lateinit var fakeTimeProvider: FakeAgentTimeProvider
  private lateinit var fakeMcpClient: FakeAgentMCPClient
  private lateinit var fakeAIAgent: FakeAIAgent
  private lateinit var autoMobileAgent: AutoMobileAgent

  @TempDir lateinit var tempDir: File

  @BeforeEach
  fun setUp() {
    fakeConfigProvider = FakeAgentConfigProvider()
    fakeFileSystemOperations = FakeAgentFileSystemOperations()
    fakeAIAgent = FakeAIAgent()
    fakeAiAgentFactory = FakeAgentAIAgentFactory(fakeAIAgent)
    fakeTimeProvider = FakeAgentTimeProvider()
    fakeMcpClient = FakeAgentMCPClient()

    autoMobileAgent =
      AutoMobileAgent(
        configProvider = fakeConfigProvider,
        fileSystemOperations = fakeFileSystemOperations,
        aiAgentFactory = fakeAiAgentFactory,
        timeProvider = fakeTimeProvider,
        mcpClient = fakeMcpClient,
        recoveryConfigProvider = StaticRecoveryConfigProvider(maxToolCalls = 5),
      )
  }

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
  fun `secret in a tool or observe result is scrubbed from what the recovery agent feeds the model`() {
    // Issue #6094 (CWE-200, second-order channel): after the initial (redacted) recovery prompt,
    // the Koog agent loop runs observe/tools and feeds their RESULTS (including the view hierarchy
    // from observe's withViewHierarchy=true) back to the LLM. A secret still visible on-screen at
    // recovery time must not reach the provider through those results. The agent's tools call the
    // client handed to createAIAgentWithMCPTools, so that client's returned strings are exactly
    // what
    // Koog forwards to the model — assert they are scrubbed, while the underlying client still
    // executes with real values.
    val secret = "SECRET-hunter2-TOKEN"
    val visible = "keepme-visible-env"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    // The live tool/observe results carry the on-screen secret plus non-secret context.
    fakeMcpClient.toolResults["observe"] =
      """{"elements":{"field":"token $secret"},"env":"$visible"}"""
    fakeMcpClient.toolResults["tapOn"] = """{"status":"typed $secret"}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    // Drive the exact tools Koog builds from the captured client. observe first (the view-hierarchy
    // feed) then tapOn — both results are what the agent hands the LLM.
    val agentClient = fakeAiAgentFactory.recoveryCalls.single().mcpClient
    val observeResult = runBlocking {
      AutoMobileAgent.ObserveTool(agentClient).execute(AutoMobileAgent.ObserveTool.Args())
    }
    val tapResult = runBlocking {
      AutoMobileAgent.TapOnTool(agentClient).execute(AutoMobileAgent.TapOnTool.Args(text = "OK"))
    }

    assertFalse(
      observeResult.contains(secret),
      "observe/view-hierarchy result fed to the LLM must not contain the secret",
    )
    assertTrue(
      observeResult.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
    assertTrue(observeResult.contains(visible), "non-secret context must be preserved")
    assertFalse(
      tapResult.contains(secret),
      "tap result fed to the LLM must not contain the secret",
    )

    // The tool still EXECUTED against the device with the real value: the underlying client returns
    // the raw secret, so only the model-facing wrapper scrubs it (daemon/tool execution
    // unaffected).
    val rawObserve = fakeMcpClient.callTool("observe", emptyMap())
    assertTrue(
      rawObserve.contains(secret),
      "the underlying client (device execution) still receives real values",
    )
  }

  @Test
  fun `WaitForTool's raw client redacts a failure but leaves a success untouched during recovery`() {
    // Issue #6145 follow-up: WaitForTool is wired to the RAW client so its local text match keeps
    // working (a redacted copy would falsely time out). But DefaultMCPClient throws with the MCP
    // server's response body / error in the message on FAILURE, which can echo on-screen secret
    // data,
    // and WaitForTool logs that message on every failed poll. attemptAiRecovery must wrap the raw
    // client it hands WaitForTool in FailureRedactingMCPClient rather than passing mcpClient itself
    // unwrapped, so a thrown exception is redacted while a successful call stays byte-for-byte raw.
    val secret = "SECRET-hunter2-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val rawClient = fakeAiAgentFactory.recoveryCalls.single().rawMcpClient

    // A successful call must return the RAW, unredacted result unchanged — WaitForTool's local
    // match relies on this.
    fakeMcpClient.toolResults["waitForCheck"] = """{"elements":[{"text":"$secret"}]}"""
    assertEquals(
      """{"elements":[{"text":"$secret"}]}""",
      rawClient.callTool("waitForCheck", emptyMap()),
      "a successful observe must reach WaitForTool's local match completely unredacted",
    )

    // A FAILED call's thrown message must be redacted — this is what WaitForTool logs on every
    // failed poll attempt.
    fakeMcpClient.toolFailures["waitForFailure"] =
      RuntimeException("MCP server error: token $secret leaked in the error body")
    val error = assertThrows<RuntimeException> { rawClient.callTool("waitForFailure", emptyMap()) }
    assertFalse(
      error.message!!.contains(secret),
      "a failed observe's exception message must not leak the secret",
    )
    assertTrue(
      error.message!!.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `attemptAiRecovery redacts raw context fields from the initial prompt for a direct caller`() {
    // A direct caller of the public overload may build a FailedStepContext with RAW (unredacted)
    // planContent/error plus raw secretValues. The entry point must scrub the static context fields
    // itself so the first prompt does not leak — not only the executor path, which pre-redacts
    // (#6094).
    val secret = "SECRET-hunter2-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "timed out entering $secret",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps:\n  - tool: inputText\n    text: \"$secret\"",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    fakeMcpClient.toolResults["observe"] = """{"elements": []}"""
    fakeAIAgent.response = "done"

    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val prompt = fakeAIAgent.prompts.single()
    assertFalse(
      prompt.contains(secret),
      "raw context fields must be redacted from the initial recovery prompt",
    )
    assertTrue(
      prompt.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `attemptAiRecovery normalizes raw secret values a direct caller passes`() {
    // The public overload may be called directly with RAW concrete secrets (not pre-expanded). The
    // entry point must expand them so the JSON-escaped form of a special-character secret in a tool
    // result is still scrubbed (#6094). Here the secret contains a quote, so it appears escaped in
    // the JSON observe result; passing only the raw value would leak it.
    val secret = "pa\"ss-TOKEN"
    val context =
      FailedStepContext(
        failedStepIndex = 1,
        failedTool = "inputText",
        error = "step failed",
        succeededSteps = emptyList(),
        planContent = "name: test\nsteps: []",
        deviceId = "emulator-5554",
      )
    val modelConfig = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")

    fakeTimeProvider.times = ArrayDeque(listOf(1000L, 2000L))
    fakeConfigProvider.serverUrl = "http://localhost:3000"
    fakeMcpClient.connected = false
    fakeConfigProvider.configuredModel = modelConfig
    // The JSON observe result carries the secret in its escaped form (a `"` becomes `\"`).
    fakeMcpClient.toolResults["observe"] = """{"field":"token pa\"ss-TOKEN"}"""
    fakeAIAgent.response = "done"

    // Pass the RAW concrete secret, not a pre-expanded list.
    autoMobileAgent.attemptAiRecovery(context, secretValues = listOf(secret))

    val observeResult = runBlocking {
      AutoMobileAgent.ObserveTool(fakeAiAgentFactory.recoveryCalls.single().mcpClient)
        .execute(AutoMobileAgent.ObserveTool.Args())
    }
    assertFalse(
      observeResult.contains("""pa\"ss-TOKEN"""),
      "the escaped form of a raw-passed secret must still be scrubbed",
    )
    assertTrue(
      observeResult.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
  }

  @Test
  fun `RedactingMCPClient scrubs the secret from a tool error message fed back to the model`() {
    // A tool failure message can echo the on-screen secret (DefaultMCPClient throws a
    // RuntimeException carrying the MCP server's response body / error), and Koog feeds tool
    // errors back to the model. The redacting wrapper must scrub the throw path too, not just the
    // successful return (issue #6094 — mirrors iOS executeTool's error scrub).
    val secret = "SECRET-hunter2-TOKEN"
    val throwingDelegate =
      object : AutoMobileAgent.MCPClient {
        override fun isConnected() = true

        override fun connect(serverUrl: String) {}

        override fun disconnect() {}

        override fun callTool(toolName: String, parameters: Map<String, Any>): String =
          throw RuntimeException("MCP server returned status 500: {\"field\":\"token $secret\"}")

        override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
      }
    val client = RedactingMCPClient(throwingDelegate, SecretRedactor.secretValues(listOf(secret)))

    val error = assertThrows<RuntimeException> { client.callTool("observe", emptyMap()) }

    assertFalse(
      error.message!!.contains(secret),
      "a tool error fed back to the model must not contain the secret",
    )
    assertTrue(
      error.message!!.contains(SecretRedactor.PLACEHOLDER),
      "the secret must be replaced by the placeholder",
    )
    // The cause is dropped so the raw secret cannot survive in the exception chain.
    assertEquals(null, error.cause)
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
