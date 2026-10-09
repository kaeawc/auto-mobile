package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import dev.jasonpearson.automobile.validation.GenericToolResponse
import dev.jasonpearson.automobile.validation.TapOnResponse
import io.mockk.coEvery
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.runs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

/**
 * Interactions no single change covers: #10090 (`toolResults` addressed by plan step index, with a
 * gap where an optional step was skipped), #10093 (`${param}` substitution re-serializes the plan
 * before it is sent) and the recovery path (#10089), whose prompt and resume are built from that
 * response.
 *
 * The daemon fake derives each response from the plan the runner actually SENT, the way the real
 * daemon numbers steps, so a re-serialization that dropped or reordered a step would misalign the
 * indices. The failed-step payload for the device-id cases is the real capture
 * `captured/execute-plan-failed-step.json` (test/server/executePlanToolResultsCapture.test.ts).
 */
class PlanRecoveryInteractionTest {
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var daemon: PlanInteractionDaemon
  private lateinit var recordingAgent: PlanInteractionRecordingAgent

  @Before
  fun setup() {
    daemon = PlanInteractionDaemon()
    recordingAgent = PlanInteractionRecordingAgent()
    DaemonSocketClientManager.testClient = daemon
    AutoMobileSharedUtils.testDeviceChecker = PlanInteractionDeviceChecker()
    DaemonHeartbeat.testController = PlanInteractionHeartbeat()
    AutoMobilePlanExecutor.testAgent = recordingAgent
    System.setProperty("automobile.ci.mode", "false")
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testClient = null
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    System.clearProperty("automobile.ci.mode")
  }

  // ── #10090 x #10093 x recovery ──────────────────────────────────────────

  @Test
  fun `placeholder plan keeps result step indices aligned across a recovery resume`() {
    daemon.failAtStep = 3
    daemon.succeedOnResume = true

    val result = executePlaceholderPlan()

    assertTrue("the resumed run passes", result.success)
    assertTrue(result.aiRecoverySuccessful)

    // The plan the daemon received was re-serialized by the substitution: same steps, same order,
    // values exactly as supplied (including the YAML-hostile ones).
    val sent = daemon.sentPlans.first()
    assertEquals(
      listOf("inputText", "tapOn", "tapOn", "tapOn"),
      sent.map { it["tool"] },
    )
    assertEquals(HOSTILE_GREETING, sent[0]["text"])
    assertEquals("Confirm", sent[3]["text"])

    // First run completed steps 0 and 2 (step 1 was skipped, leaving a gap); the resume re-ran
    // step 3 only. Results stay addressed by plan step index, not by position.
    assertEquals(listOf(0, 2, 3), result.toolResults.map { it.stepIndex })
    assertEquals("inputText", result.getToolResult(0)?.toolName)
    assertNull("a skipped step has no entry", result.getToolResultEntry(1))
    assertEquals("tapOn", result.getToolResult(2)?.toolName)
    assertEquals(
      "step 2 carries the substituted value it ran with",
      "Second step",
      resultMessage(result, 2),
    )
    assertEquals(HOSTILE_GREETING, resultMessage(result, 0))
    assertEquals("Confirm", resultMessage(result, 3))

    // The recovery context was built from the same gap-bearing response.
    val context = recordingAgent.contexts.single()
    assertEquals(3, context.failedStepIndex)
    assertEquals(
      listOf(0 to "inputText", 2 to "tapOn"),
      context.succeededSteps.map { it.stepIndex to it.tool },
    )
    assertEquals(
      "the resume re-runs the failed step",
      listOf(0, 3),
      daemon.startSteps,
    )
  }

  @Test
  fun `recovery prompt lists succeeded steps by plan index across a skipped step`() {
    daemon.failAtStep = 3
    daemon.succeedOnResume = true
    val prompts = mutableListOf<String>()
    val aiAgent = mockk<AIAgent<String, String>>(relaxed = true)
    coEvery { aiAgent.run(capture(prompts)) } returns "done"
    AutoMobilePlanExecutor.testAgent = realRecoveryAgent(aiAgent)

    val result = executePlaceholderPlan()

    assertTrue(result.success)
    val prompt = prompts.single()
    assertTrue(prompt, prompt.contains("FAILED STEP: Step 4 using tool \"tapOn\""))
    assertTrue(prompt, prompt.contains("- Step 1: inputText (completed)"))
    assertTrue(prompt, prompt.contains("- Step 3: tapOn (completed)"))
    assertFalse("the skipped step is not listed as completed", prompt.contains("- Step 2:"))
    assertFalse("the failed step is not listed as completed", prompt.contains("- Step 4:"))
    assertTrue(
      "the prompt carries the substituted plan",
      prompt.contains("name: recovery-interaction"),
    )
  }

  // ── #10089: the pinned device is a real device id, never a label ────────

  @Test
  fun `resume pins to the device id the failed plan ran on`() {
    daemon.cannedFailure = failedPayload { it }
    val result = executeSimplePlan()

    assertTrue(result.success)
    assertEquals("emulator-5554", recordingAgent.contexts.single().deviceId)
    assertEquals("emulator-5554", daemon.deviceIdArgs[1])
  }

  @Test
  fun `recovery and the resumed plan reuse the failed attempt's session`() {
    daemon.cannedFailure = failedPayload { it }
    val result = executeSimplePlan()

    assertTrue(result.success)
    val failedAttemptSession = daemon.sessionUuidArgs[0]
    assertNotNull(failedAttemptSession)
    assertEquals(failedAttemptSession, recordingAgent.contexts.single().sessionUuid)
    assertEquals(failedAttemptSession, daemon.sessionUuidArgs[1])
  }

  // ── #10834: the device stays held between the failed attempt and recovery ──

  @Test
  fun `a failed attempt keeps its session for recovery and the resume takes it over`() {
    daemon.cannedFailure = failedPayload { it }
    val result = executeSimplePlan()

    assertTrue(result.success)
    assertEquals(
      "only the attempt recovery may follow asks the daemon to hold its session",
      listOf(true, null),
      daemon.holdSessionOnFailureArgs,
    )
    assertEquals(
      "the resumed plan releases the session itself, the runner does not",
      emptyList<Pair<String, String?>>(),
      daemon.daemonMethodCalls,
    )
  }

  @Test
  fun `a failed recovery releases the held session`() {
    daemon.cannedFailure = failedPayload { it }
    recordingAgent.recoverySucceeds = false

    val result = executeSimplePlan()

    assertFalse(result.success)
    assertTrue(result.aiRecoveryAttempted)
    assertEquals(
      listOf("daemon/releaseSession" to daemon.sessionUuidArgs[0]),
      daemon.daemonMethodCalls,
    )
  }

  @Test
  fun `a failure with no recovery to follow holds nothing`() {
    daemon.cannedFailure = failedPayload { it }
    val result =
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(aiAssistance = false),
      )

    assertFalse(result.success)
    assertEquals(listOf<Boolean?>(null), daemon.holdSessionOnFailureArgs)
    assertEquals(emptyList<Pair<String, String?>>(), daemon.daemonMethodCalls)
  }

  @Test
  fun `a multi-device failure pins the label's mapped device id`() {
    daemon.cannedFailure = failedPayload { payload ->
      payload.with(
        "deviceMapping" to
          JsonObject(
            mapOf("A" to JsonPrimitive("emulator-5554"), "B" to JsonPrimitive("emulator-5556")),
          ),
        failedStep = { it.with("device" to JsonPrimitive("B")) },
      )
    }
    val result = executeSimplePlan()

    assertTrue(result.success)
    assertEquals("emulator-5556", recordingAgent.contexts.single().deviceId)
    assertEquals("emulator-5556", daemon.deviceIdArgs[1])
  }

  @Test
  fun `a device label with no mapping is never used as the device id`() {
    daemon.cannedFailure = failedPayload { payload ->
      payload.with(failedStep = { it.with("device" to JsonPrimitive("B")) })
    }
    val result = executeSimplePlan()

    assertTrue(result.success)
    assertNull(
      "the label B is not an id, and the primary device is another track",
      recordingAgent.contexts.single().deviceId,
    )
    assertNull("the resume must not pin the label", daemon.deviceIdArgs[1])
  }

  @Test
  fun `a failure payload with no device id falls back to the configured device, not auto`() {
    daemon.cannedFailure = failedPayload { it.without("deviceId") }
    val result =
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(aiAssistance = true, device = "emulator-5558"),
      )

    assertTrue(result.success)
    assertEquals("emulator-5558", recordingAgent.contexts.single().deviceId)
    assertEquals("emulator-5558", daemon.deviceIdArgs[1])

    // And with the default "auto" there is nothing to pin.
    daemon.reset()
    recordingAgent.contexts.clear()
    daemon.cannedFailure = failedPayload { it.without("deviceId") }
    executeSimplePlan()
    assertNull(recordingAgent.contexts.single().deviceId)
    assertNull(daemon.deviceIdArgs[1])
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private fun executePlaceholderPlan(): AutoMobilePlanExecutionResult =
    AutoMobilePlanExecutor.execute(
      "test-plans/recovery-interaction.yaml",
      mapOf(
        "greeting" to HOSTILE_GREETING,
        "dismiss" to "Dismiss",
        "second" to "Second step",
        "target" to "Confirm",
      ),
      AutoMobilePlanExecutionOptions(aiAssistance = true),
    )

  private fun executeSimplePlan(): AutoMobilePlanExecutionResult =
    AutoMobilePlanExecutor.execute(
      "test-plans/launch-clock-app.yaml",
      emptyMap(),
      AutoMobilePlanExecutionOptions(aiAssistance = true),
    )

  private fun resultMessage(result: AutoMobilePlanExecutionResult, stepIndex: Int): String? {
    val entry = result.getToolResult(stepIndex)
    assertNotNull("step $stepIndex has a parsed result", entry)
    return when (val response = entry?.response) {
      is TapOnResponse -> response.message
      is GenericToolResponse ->
        (response.payload as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
      else -> null
    }
  }

  /** The real captured failed-step payload, optionally edited, as the daemon's response. */
  private fun failedPayload(edit: (JsonObject) -> JsonObject): DaemonResponse {
    val text =
      checkNotNull(javaClass.classLoader.getResource("captured/execute-plan-failed-step.json"))
        .readText()
    val envelope = json.parseToJsonElement(text).jsonObject
    val payload =
      edit(
        json
          .parseToJsonElement(
            envelope
              .getValue("content")
              .jsonArray[0]
              .jsonObject
              .getValue("text")
              .jsonPrimitive
              .content,
          )
          .jsonObject,
      )
    return planResponse(payload)
  }

  private fun JsonObject.with(
    vararg entries: Pair<String, JsonElement>,
    failedStep: ((JsonObject) -> JsonObject)? = null,
  ): JsonObject {
    val updated = this.toMutableMap().apply { putAll(entries) }
    if (failedStep != null) {
      updated["failedStep"] = failedStep(getValue("failedStep").jsonObject)
    }
    return JsonObject(updated)
  }

  private fun JsonObject.without(key: String): JsonObject = JsonObject(this - key)

  private fun realRecoveryAgent(aiAgent: AIAgent<String, String>): AutoMobileAgent {
    val config = mockk<AutoMobileAgent.ConfigProvider>()
    every { config.getMcpServerUrl() } returns "http://localhost:0"
    every { config.getModelConfig() } returns
      AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    val factory = mockk<AutoMobileAgent.AIAgentFactory>()
    every { factory.createAIAgentWithMCPTools(any(), any(), any(), any()) } returns aiAgent
    val mcp = mockk<AutoMobileAgent.MCPClient>()
    every { mcp.isConnected() } returns true
    every { mcp.disconnect() } just runs
    every { mcp.callTool("observe", any()) } returns "{}"
    val time = mockk<AutoMobileAgent.TimeProvider>()
    every { time.currentTimeMillis() } returns 1000L
    return AutoMobileAgent(
      configProvider = config,
      fileSystemOperations = mockk(relaxed = true),
      aiAgentFactory = factory,
      timeProvider = time,
      mcpClient = mcp,
      recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = true, maxToolCalls = 5),
    )
  }

  private companion object {
    // Breaks the old text splice in a double-quoted scalar (quote, backslash, ` #`, `: `).
    const val HOSTILE_GREETING = "He said \"hi\" #1: C:\\temp"
  }
}

private fun planResponse(payload: JsonObject): DaemonResponse {
  val text = Json.encodeToString(JsonElement.serializer(), payload)
  val result =
    JsonObject(
      mapOf(
        "content" to
          JsonArray(
            listOf(
              JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text))),
            ),
          ),
      ),
    )
  return DaemonResponse(id = "t", type = "mcp_response", success = true, result = result)
}

/**
 * Daemon fake that numbers steps from the plan the runner sent (as the real daemon does): a step
 * that fails is reported, a skipped optional step leaves a gap, a completed step gets a
 * `{stepIndex, tool, result}` entry. [cannedFailure], when set, is returned verbatim for the first
 * `executePlan` call and a success for the next.
 */
private class PlanInteractionDaemon : DaemonToolClient {
  var failAtStep: Int? = null
  var succeedOnResume = false
  var cannedFailure: DaemonResponse? = null
  val sentPlans = mutableListOf<List<Map<*, *>>>()
  val startSteps = mutableListOf<Int>()
  val deviceIdArgs = mutableListOf<String?>()
  val sessionUuidArgs = mutableListOf<String?>()
  val holdSessionOnFailureArgs = mutableListOf<Boolean?>()
  val daemonMethodCalls = mutableListOf<Pair<String, String?>>()
  private var calls = 0
  override var sessionUuid: String = "plan-interaction-session"

  fun reset() {
    calls = 0
    startSteps.clear()
    deviceIdArgs.clear()
    sentPlans.clear()
  }

  override fun callTool(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    if (toolName == "setToolEnabled") {
      return DaemonResponse(id = "enable", type = "mcp_response", success = true)
    }
    val call = calls++
    val startStep = arguments["startStep"]?.jsonPrimitive?.content?.toInt() ?: 0
    startSteps.add(startStep)
    deviceIdArgs.add((arguments["deviceId"] as? JsonPrimitive)?.contentOrNull)
    sessionUuidArgs.add((arguments["sessionUuid"] as? JsonPrimitive)?.contentOrNull)
    holdSessionOnFailureArgs.add(
      (arguments["holdSessionOnFailure"] as? JsonPrimitive)?.contentOrNull?.toBoolean(),
    )
    val steps = decodeSteps(arguments)
    sentPlans.add(steps)

    cannedFailure?.let {
      return if (call == 0) it else succeeded(steps, startStep)
    }
    val failAt = failAtStep
    return if (failAt != null && call == 0) failed(steps, startStep, failAt)
    else succeeded(steps, startStep)
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    throw IllegalStateException("readResource not configured for $uri")
  }

  override fun callDaemonMethod(
    method: String,
    params: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    daemonMethodCalls.add(method to (params["sessionId"] as? JsonPrimitive)?.contentOrNull)
    return DaemonResponse(id = "method", type = "daemon_response", success = true)
  }

  private fun decodeSteps(arguments: JsonObject): List<Map<*, *>> {
    val encoded = arguments.getValue("planContent").jsonPrimitive.content.removePrefix("base64:")
    val yaml = String(java.util.Base64.getDecoder().decode(encoded))
    val plan = Yaml(SafeConstructor(LoaderOptions())).load<Any?>(yaml) as Map<*, *>
    return (plan["steps"] as List<*>).map { it as Map<*, *> }
  }

  private fun entry(index: Int, step: Map<*, *>): JsonObject =
    JsonObject(
      mapOf(
        "stepIndex" to JsonPrimitive(index),
        "tool" to JsonPrimitive(step["tool"].toString()),
        "result" to
          JsonObject(
            mapOf(
              "success" to JsonPrimitive(true),
              "message" to (step["text"]?.let { JsonPrimitive(it.toString()) } ?: JsonNull),
            ),
          ),
      ),
    )

  private fun isSkipped(step: Map<*, *>) = step["optional"] == true

  private fun walk(
    steps: List<Map<*, *>>,
    startStep: Int,
    stopAt: Int,
  ): Pair<JsonArray, JsonArray> {
    val completed = mutableListOf<JsonElement>()
    val skipped = mutableListOf<JsonElement>()
    for (index in startStep until minOf(stopAt, steps.size)) {
      val step = steps[index]
      if (isSkipped(step)) {
        skipped.add(
          JsonObject(
            mapOf(
              "stepIndex" to JsonPrimitive(index),
              "tool" to JsonPrimitive(step["tool"].toString()),
              "error" to JsonPrimitive("Element not found"),
            ),
          ),
        )
      } else {
        completed.add(entry(index, step))
      }
    }
    return JsonArray(completed) to JsonArray(skipped)
  }

  private fun succeeded(steps: List<Map<*, *>>, startStep: Int): DaemonResponse {
    val (completed, skipped) = walk(steps, startStep, steps.size)
    return planResponse(
      JsonObject(
        mapOf(
          "success" to JsonPrimitive(true),
          "executedSteps" to JsonPrimitive(completed.size),
          "totalSteps" to JsonPrimitive(steps.size),
          "platform" to JsonPrimitive("android"),
          "deviceId" to JsonPrimitive("emulator-5554"),
          "skippedSteps" to skipped,
          "toolResults" to completed,
        ),
      ),
    )
  }

  private fun failed(steps: List<Map<*, *>>, startStep: Int, failAt: Int): DaemonResponse {
    val (completed, skipped) = walk(steps, startStep, failAt)
    return planResponse(
      JsonObject(
        mapOf(
          "success" to JsonPrimitive(false),
          "executedSteps" to JsonPrimitive(completed.size),
          "totalSteps" to JsonPrimitive(steps.size),
          "failedStep" to
            JsonObject(
              mapOf(
                "stepIndex" to JsonPrimitive(failAt),
                "tool" to JsonPrimitive(steps[failAt]["tool"].toString()),
                "error" to JsonPrimitive("Element not found"),
              ),
            ),
          "error" to JsonPrimitive("Element not found"),
          "platform" to JsonPrimitive("android"),
          "deviceId" to JsonPrimitive("emulator-5554"),
          "skippedSteps" to skipped,
          "toolResults" to completed,
        ),
      ),
    )
  }
}

private class PlanInteractionRecordingAgent :
  AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = true)) {
  val contexts = mutableListOf<FailedStepContext>()
  var recoverySucceeds = true

  override fun attemptAiRecovery(
    context: FailedStepContext,
    secretValues: List<String>,
  ): RecoveryOutcome {
    contexts.add(context)
    return RecoveryOutcome(
      success = recoverySucceeds,
      recoveryTimeMs = 1,
      observeResultAfterRecovery = "{}",
    )
  }
}

private class PlanInteractionDeviceChecker : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable() = true

  override fun getDeviceCount() = 1
}

private class PlanInteractionHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
