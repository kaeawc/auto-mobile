package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Tests for the Koog recovery loop in [AutoMobilePlanExecutor].
 *
 * Verifies: once-per-test guard, resume-from-step, structured context, config provider usage, and
 * that recovery is skipped when aiAssistance=false or CI mode is on.
 */
class RecoveryLoopTest {
  private lateinit var collaborators: PlanExecutorCollaborators
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var fakeDaemonClient: RecoveryFakeDaemonToolClient
  private lateinit var fakeAgent: RecoveryFakeAutoMobileAgent

  @Before
  fun setup() {
    fakeDaemonClient = RecoveryFakeDaemonToolClient()
    fakeAgent = RecoveryFakeAutoMobileAgent()
    collaborators =
      PlanExecutorCollaborators(
        agent = { fakeAgent },
        deviceChecker = RecoveryFakeDeviceChecker(),
        daemon = fakeDaemonClient,
        heartbeat = RecoveryFakeHeartbeat(),
      )
    // Force CI mode off so recovery tests can exercise the recovery path
    // even when running in CI (where CI env var is set)
    System.setProperty("automobile.ci.mode", "false")
  }

  @After
  fun tearDown() {
    System.clearProperty("automobile.ci.mode")
  }

  @Test
  fun `recovery fires on failure when aiAssistance is true`() {
    // First call fails at step 2, second call (resume) succeeds
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 2, failedTool = "tapOn"))
    fakeDaemonClient.responses.add(buildSuccessResponse())
    fakeAgent.recoveryOutcome =
      RecoveryOutcome(success = true, recoveryTimeMs = 100, observeResultAfterRecovery = "{}")

    val result = executePlan(aiAssistance = true)

    assertTrue("Test should pass after recovery + resume", result.success)
    assertTrue("Recovery should have been attempted", result.aiRecoveryAttempted)
    assertTrue("Recovery should be marked successful", result.aiRecoverySuccessful)
    assertEquals(1, fakeAgent.recoveryCalls.size)
  }

  @Test
  fun `real recovery client uses the execution wait budget and sleeper`() {
    val waits = mutableListOf<Long>()
    var calls = 0
    val client = FakeMCPClient { _, parameters ->
      calls++
      assertTrue(parameters.containsKey("sessionUuid"))
      throw IllegalStateException("""{"code":"device_owned_by_other_session"}""")
    }
    val recoveryAgent = recoveryAgent(client) { it.callTool("tapOn", emptyMap()) }
    collaborators =
      collaborators.copy(
        agent = { recoveryAgent },
        timings =
          PlanExecutorTimings(
            deviceOwnedWaitBudgetMs = 600L,
            deviceOwnedSleeper = { waits.add(it) },
          ),
      )
    fakeDaemonClient.responses.add(
      buildFailureResponse(
        failedStepIndex = 1,
        failedTool = "tapOn",
        details = FailureDetails(deviceId = "emulator-5554"),
      ),
    )

    val result = executePlan(aiAssistance = true)

    assertFalse(result.success)
    assertTrue(result.aiRecoveryAttempted)
    assertEquals(listOf(500L, 100L), waits)
    assertEquals(3, calls)
  }

  @Test
  fun `real recovery client stops before a device call when its injected heartbeat loses the session`() {
    var lost = false
    var calls = 0
    val client = FakeMCPClient { _, _ ->
      calls++
      "{}"
    }
    val recoveryAgent =
      recoveryAgent(client) {
        lost = true
        it.callTool("tapOn", emptyMap())
      }
    collaborators =
      collaborators.copy(
        agent = { recoveryAgent },
        heartbeat =
          RecoveryFakeHeartbeat { session ->
            if (lost) DaemonSessionLoss(session, "idle", "Session not found") else null
          },
        timings =
          PlanExecutorTimings(deviceOwnedSleeper = { error("A lost session must not wait") }),
      )
    fakeDaemonClient.responses.add(
      buildFailureResponse(
        failedStepIndex = 1,
        failedTool = "tapOn",
        details = FailureDetails(deviceId = "emulator-5554"),
      ),
    )

    val result = executePlan(aiAssistance = true)

    assertFalse(result.success)
    assertTrue(result.aiRecoveryAttempted)
    assertTrue(result.errorMessage.contains("releaseReason: idle"))
    assertEquals(0, calls)
  }

  private fun recoveryAgent(
    client: AutoMobileAgent.MCPClient,
    onRecoveryClient: (AutoMobileAgent.MCPClient) -> Unit,
  ): AutoMobileAgent =
    AutoMobileAgent(
      configProvider = FakeConfigProvider(),
      fileSystemOperations = FakeFileSystemOps(),
      aiAgentFactory = FakeAIAgentFactory(onRecoveryClient),
      timeProvider =
        object : AutoMobileAgent.TimeProvider {
          override fun currentTimeMillis() = 0L
        },
      mcpClient = client,
      recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = true),
    )

  @Test
  fun `recovery does NOT fire when aiAssistance is false`() {
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 1, failedTool = "tapOn"))

    val result = executePlan(aiAssistance = false)

    assertFalse("Test should fail", result.success)
    assertFalse("Recovery should not have been attempted", result.aiRecoveryAttempted)
    assertEquals(0, fakeAgent.recoveryCalls.size)
  }

  @Test
  fun `recovery does NOT fire when ai-recovery feature flag is disabled`() {
    // Replace the agent with one whose recoveryConfigProvider returns enabled=false
    fakeAgent = RecoveryFakeAutoMobileAgent(recoveryEnabled = false)
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 1, failedTool = "tapOn"))

    val result = executePlan(aiAssistance = true)

    assertFalse("Test should fail when feature flag is disabled", result.success)
    assertEquals(0, fakeAgent.recoveryCalls.size)
  }

  @Test
  fun `recovery does NOT fire in CI mode`() {
    System.setProperty("automobile.ci.mode", "true")
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 1, failedTool = "tapOn"))

    val result = executePlan(aiAssistance = true)

    assertFalse("Test should fail in CI mode", result.success)
    assertEquals(0, fakeAgent.recoveryCalls.size)
  }

  @Test
  fun `once-per-test guard prevents second recovery attempt`() {
    // First call fails at step 2 → recovery → resume from step 3 → fails at step 4
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 2, failedTool = "tapOn"))
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 4, failedTool = "swipe"))
    fakeAgent.recoveryOutcome =
      RecoveryOutcome(success = true, recoveryTimeMs = 100, observeResultAfterRecovery = "{}")

    val result = executePlan(aiAssistance = true)

    assertFalse("Test should fail after second step failure (no retry)", result.success)
    assertTrue("Recovery should have been attempted", result.aiRecoveryAttempted)
    assertEquals("Recovery should only be called once", 1, fakeAgent.recoveryCalls.size)
  }

  @Test
  fun `resume re-runs the failed step so its action is retried, not skipped`() {
    // First call fails at step 2 (index)
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 2, failedTool = "tapOn"))
    fakeDaemonClient.responses.add(buildSuccessResponse())
    fakeAgent.recoveryOutcome =
      RecoveryOutcome(success = true, recoveryTimeMs = 100, observeResultAfterRecovery = "{}")

    executePlan(aiAssistance = true)

    // The resume call must re-run the FAILED step itself (startStep == failedStepIndex),
    // not skip ahead to failedStepIndex + 1 — the agent only cleared the interruption, so
    // the step's own action still needs to run.
    assertEquals("Should have made 2 daemon calls", 2, fakeDaemonClient.callArgs.size)
    val resumeArgs = fakeDaemonClient.callArgs[1]
    assertEquals(2, resumeArgs["startStep"]?.let { (it as JsonPrimitive).content.toInt() })
  }

  @Test
  fun `resume pins to the same device that was recovered`() {
    // The daemon reports the device the plan ran on as the payload's top-level deviceId;
    // `failedStep.device` is only a plan device LABEL (multi-device plans), never an id (#10089).
    fakeDaemonClient.responses.add(
      buildFailureResponse(
        failedStepIndex = 1,
        failedTool = "tapOn",
        details = FailureDetails(deviceId = "emulator-5554"),
      ),
    )
    fakeDaemonClient.responses.add(buildSuccessResponse())
    fakeAgent.recoveryOutcome =
      RecoveryOutcome(success = true, recoveryTimeMs = 50, observeResultAfterRecovery = "{}")

    // Execute with device="auto" (default)
    executePlan(aiAssistance = true)

    assertEquals("Should have made 2 daemon calls", 2, fakeDaemonClient.callArgs.size)
    // First call should NOT have deviceId (auto mode)
    assertNull(
      "First call should not pin a device",
      fakeDaemonClient.callArgs[0]["deviceId"],
    )
    // Resume call should pin to the recovered device
    assertEquals(
      "Resume should pin to recovered device",
      "emulator-5554",
      fakeDaemonClient.callArgs[1]["deviceId"]?.let { (it as JsonPrimitive).content },
    )
  }

  @Test
  fun `FailedStepContext is populated correctly`() {
    // The daemon tags each completed step with its plan step index (a skipped optional step
    // leaves a gap), so steps 0 and 2 completed, step 1 was skipped and step 3 failed (#10090).
    val toolResults =
      JsonArray(
        listOf(
          JsonObject(mapOf("stepIndex" to JsonPrimitive(0), "tool" to JsonPrimitive("observe"))),
          JsonObject(mapOf("stepIndex" to JsonPrimitive(2), "tool" to JsonPrimitive("tapOn"))),
        ),
      )
    fakeDaemonClient.responses.add(
      buildFailureResponse(
        failedStepIndex = 3,
        failedTool = "swipe",
        error = "No scrollable container",
        details = FailureDetails(toolResults = toolResults),
      ),
    )
    fakeDaemonClient.responses.add(buildSuccessResponse())
    fakeAgent.recoveryOutcome =
      RecoveryOutcome(success = true, recoveryTimeMs = 50, observeResultAfterRecovery = "{}")

    executePlan(aiAssistance = true)

    assertEquals(1, fakeAgent.recoveryCalls.size)
    val context = fakeAgent.recoveryCalls[0]
    assertEquals(3, context.failedStepIndex)
    assertEquals("swipe", context.failedTool)
    assertEquals("No scrollable container", context.error)
    assertEquals(2, context.succeededSteps.size)
    assertEquals(0, context.succeededSteps[0].stepIndex)
    assertEquals("observe", context.succeededSteps[0].tool)
    assertEquals(2, context.succeededSteps[1].stepIndex)
    assertEquals("tapOn", context.succeededSteps[1].tool)
  }

  @Test
  fun `recovery failure results in test failure`() {
    fakeDaemonClient.responses.add(buildFailureResponse(failedStepIndex = 1, failedTool = "tapOn"))
    fakeAgent.recoveryOutcome = RecoveryOutcome(success = false, recoveryTimeMs = 200)

    val result = executePlan(aiAssistance = true)

    assertFalse("Test should fail when recovery fails", result.success)
    assertTrue("Recovery should have been attempted", result.aiRecoveryAttempted)
    assertFalse("Recovery should be marked unsuccessful", result.aiRecoverySuccessful)
    assertEquals(1, fakeAgent.recoveryCalls.size)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private fun executePlan(aiAssistance: Boolean): AutoMobilePlanExecutionResult {
    return PlanExecutor(collaborators)
      .execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(aiAssistance = aiAssistance),
      )
  }

  private fun buildSuccessResponse(): DaemonResponse {
    return buildDaemonResponse(
      JsonObject(
        mapOf(
          "success" to JsonPrimitive(true),
          "executedSteps" to JsonPrimitive(5),
          "totalSteps" to JsonPrimitive(5),
        ),
      ),
    )
  }

  private data class FailureDetails(
    val toolResults: JsonArray? = null,
    val device: String? = null,
    val deviceId: String? = null,
  )

  private fun buildFailureResponse(
    failedStepIndex: Int,
    failedTool: String,
    error: String = "Element not found",
    details: FailureDetails = FailureDetails(),
  ): DaemonResponse {
    val (toolResults, device, deviceId) = details
    val failedStepFields =
      mutableMapOf<String, JsonElement>(
        "stepIndex" to JsonPrimitive(failedStepIndex),
        "tool" to JsonPrimitive(failedTool),
        "error" to JsonPrimitive(error),
      )
    if (device != null) {
      failedStepFields["device"] = JsonPrimitive(device)
    }
    val payload =
      mutableMapOf<String, JsonElement>(
        "success" to JsonPrimitive(false),
        "executedSteps" to JsonPrimitive(failedStepIndex),
        "totalSteps" to JsonPrimitive(5),
        "failedStep" to JsonObject(failedStepFields),
      )
    if (toolResults != null) {
      payload["toolResults"] = toolResults
    }
    if (deviceId != null) {
      payload["deviceId"] = JsonPrimitive(deviceId)
    }
    return buildDaemonResponse(JsonObject(payload))
  }

  private fun buildDaemonResponse(payload: JsonObject): DaemonResponse {
    val textPayload = json.encodeToString(JsonElement.serializer(), payload)
    val result =
      JsonObject(
        mapOf(
          "content" to
            JsonArray(
              listOf(
                JsonObject(
                  mapOf(
                    "type" to JsonPrimitive("text"),
                    "text" to JsonPrimitive(textPayload),
                  ),
                ),
              ),
            ),
        ),
      )
    return DaemonResponse(
      id = "test",
      type = "mcp_response",
      success = true,
      result = result,
      error = null,
    )
  }
}

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Fake daemon client that returns responses in order and records call arguments. */
private class RecoveryFakeDaemonToolClient : DaemonToolClient {
  val responses = mutableListOf<DaemonResponse>()
  val callArgs = mutableListOf<JsonObject>()
  val toolSelectionCallArgs = mutableListOf<JsonObject>()
  private var callIndex = 0
  override var sessionUuid: String = "recovery-test-session"

  override fun callTool(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    if (toolName == "setToolEnabled") {
      toolSelectionCallArgs.add(arguments)
      return DaemonResponse(id = "tool-selection", type = "mcp_response", success = true)
    }
    callArgs.add(arguments)
    return if (callIndex < responses.size) {
      responses[callIndex++]
    } else {
      throw IllegalStateException("No more responses configured (call $callIndex)")
    }
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    throw IllegalStateException("readResource not configured for $uri")
  }
}

/** Fake agent that records recovery calls and returns a configured outcome. */
private class RecoveryFakeAutoMobileAgent(recoveryEnabled: Boolean = true) :
  AutoMobileAgent(
    configProvider = FakeConfigProvider(),
    fileSystemOperations = FakeFileSystemOps(),
    aiAgentFactory = FakeAIAgentFactory(),
    timeProvider = FakeTimeProvider(),
    mcpClient = FakeMCPClient(),
    recoveryConfigProvider =
      StaticRecoveryConfigProvider(enabled = recoveryEnabled, maxToolCalls = 5),
  ) {
  var recoveryOutcome: RecoveryOutcome = RecoveryOutcome(success = false, recoveryTimeMs = 0)
  val recoveryCalls = mutableListOf<FailedStepContext>()

  val recoverySecretValues = mutableListOf<List<String>>()

  internal override fun attemptAiRecovery(
    context: FailedStepContext,
    secretValues: List<String>,
    timings: PlanExecutorTimings,
    heartbeat: DaemonHeartbeatController,
  ): RecoveryOutcome {
    recoveryCalls.add(context)
    recoverySecretValues.add(secretValues)
    return recoveryOutcome
  }
}

private class FakeConfigProvider : AutoMobileAgent.ConfigProvider {
  override fun getModelConfig() =
    AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "fake")

  override fun getPlanMaxAgeMs() = 3600000L

  override fun isDebugMode() = false

  override fun getMcpServerUrl() = "http://localhost:0"
}

private class FakeFileSystemOps : AutoMobileAgent.FileSystemOperations {
  val directories = mutableListOf<java.io.File>()
  val writes = mutableMapOf<java.io.File, String>()

  override fun createDirectories(dir: java.io.File) {
    directories.add(dir)
  }

  override fun fileExists(file: java.io.File) = false

  override fun writeTextToFile(file: java.io.File, content: String) {
    writes[file] = content
  }

  override fun getLastModified(file: java.io.File) = 0L
}

private class FakeAIAgentFactory(
  private val onRecoveryClient: (AutoMobileAgent.MCPClient) -> Unit = {},
) : AutoMobileAgent.AIAgentFactory {
  override fun createAIAgent(
    config: AutoMobileAgent.ModelConfig,
  ): ai.koog.agents.core.agent.AIAgent<String, String> {
    throw UnsupportedOperationException("Not used in recovery tests")
  }

  override fun createAIAgentWithMCPTools(
    config: AutoMobileAgent.ModelConfig,
    mcpClient: AutoMobileAgent.MCPClient,
    maxToolCalls: Int,
  ): ai.koog.agents.core.agent.AIAgent<String, String> {
    throw UnsupportedOperationException("Not used in recovery tests")
  }

  override fun createAIAgentWithMCPTools(
    config: AutoMobileAgent.ModelConfig,
    mcpClient: AutoMobileAgent.MCPClient,
    maxToolCalls: Int,
    rawMcpClient: AutoMobileAgent.MCPClient,
  ): ai.koog.agents.core.agent.AIAgent<String, String> {
    onRecoveryClient(mcpClient)
    throw UnsupportedOperationException("The fake stops after inspecting the recovery client")
  }
}

private class FakeTimeProvider : AutoMobileAgent.TimeProvider {
  override fun currentTimeMillis() = System.currentTimeMillis()
}

private class FakeMCPClient(
  private val call: (String, Map<String, Any>) -> String = { _, _ -> "" },
) : AutoMobileAgent.MCPClient {
  override fun isConnected() = false

  val connectionUrls = mutableListOf<String>()
  var disconnectCalls = 0

  override fun connect(serverUrl: String) {
    connectionUrls.add(serverUrl)
  }

  override fun disconnect() {
    disconnectCalls++
  }

  override fun callTool(toolName: String, parameters: Map<String, Any>) = call(toolName, parameters)

  override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
}

private class RecoveryFakeDeviceChecker : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable() = true

  override fun getDeviceCount() = 1
}

private class RecoveryFakeHeartbeat(
  private val loss: (String) -> DaemonSessionLoss? = { null },
) : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit

  override fun sessionLoss(sessionId: String): DaemonSessionLoss? = loss(sessionId)
}
