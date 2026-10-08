package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.TapOnResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

class AutoMobilePlanExecutorTest {
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var fakeDaemonClient: FakeDaemonToolClient
  private lateinit var fakeDeviceChecker: FakeDeviceChecker

  @Before
  fun setup() {
    fakeDaemonClient = FakeDaemonToolClient()
    fakeDeviceChecker = FakeDeviceChecker(devicesAvailable = true)
    DaemonSocketClientManager.testClient = fakeDaemonClient
    AutoMobileSharedUtils.testDeviceChecker = fakeDeviceChecker
    DaemonHeartbeat.testController = FakeDaemonHeartbeat()
    AutoMobilePlanExecutor.testAgent =
      AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = false))
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testClient = null
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    AutoMobilePlanExecutor.retryBackoffMs = 2000L
    AutoMobilePlanExecutor.deviceOwnedSleeper = { Thread.sleep(it) }
    AutoMobilePlanExecutor.deviceOwnedWaitBudgetMs = 30_000L
  }

  @Test
  fun `a device held by another session is waited for with backoff then succeeds`() {
    val waits = mutableListOf<Long>()
    AutoMobilePlanExecutor.deviceOwnedSleeper = { waits.add(it) }
    repeat(3) {
      fakeDaemonClient.queueExecutePlanResponse(
        buildDaemonResponse(deviceOwnedPayload(), isError = true),
      )
    }
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(true, result.success)
    assertEquals(listOf(500L, 1000L, 2000L), waits)
    assertEquals(4, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a held device that never frees fails with a clear error after the wait budget`() {
    val waits = mutableListOf<Long>()
    AutoMobilePlanExecutor.deviceOwnedSleeper = { waits.add(it) }
    AutoMobilePlanExecutor.deviceOwnedWaitBudgetMs = 3_000L
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(deviceOwnedPayload(), isError = true),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(listOf(500L, 1000L, 1500L), waits)
    assertEquals(4, fakeDaemonClient.executePlanCalls)
    assertTrue(result.errorMessage, result.errorMessage.contains("device_owned_by_other_session"))
    assertTrue(result.errorMessage, result.errorMessage.contains("held by another session"))
    assertTrue(result.errorMessage, result.errorMessage.contains("waited 3000ms"))
  }

  @Test
  fun `only the typed code triggers the device held wait`() {
    val waits = mutableListOf<Long>()
    AutoMobilePlanExecutor.deviceOwnedSleeper = { waits.add(it) }
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload(
          """{"success":false,"error":"device is held by another session","retryable":false}""",
        ),
        isError = true,
      ),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(emptyList<Long>(), waits)
    assertEquals(1, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `session ownership loss is a failure with code and message`() {
    assertEnvelopeFailure(
      sessionOwnershipLostPayload(),
      "session_ownership_lost",
      "Session released",
    )
  }

  @Test
  fun `device loss is a failure with code and device id`() {
    assertEnvelopeFailure(deviceLostPayload(), "device_lost", "emulator-5554")
  }

  @Test
  fun `daemon shutdown is a failure with code and message`() {
    assertEnvelopeFailure(shutdownPayload(), "daemon_shutting_down", "Daemon is shutting down")
  }

  @Test
  fun `daemon restart pending is a failure with code and message`() {
    assertEnvelopeFailure(
      payload(
        """{"error":{"code":"daemon_restart_pending",
          "message":"Daemon restart is pending; retry provisionDevice after the replacement becomes ready.",
          "retryable":true}}""",
      ),
      "daemon_restart_pending",
      "Daemon restart is pending; retry provisionDevice after the replacement becomes ready.",
    )
  }

  @Test
  fun `session recovery assignment is a failure with code and message`() {
    assertEnvelopeFailure(
      payload(
        """{"error":{"message":"Cannot safely recover session test-session: android device 'emulator-5554' is unavailable or already in use. The session can still resume if the device returns before the recovery window ends (5 seconds remaining); otherwise acquire a new device with getAndroid or getApple.",
          "code":"session_recovery_pending","sessionUuid":"test-session","platform":"android",
          "deviceId":"emulator-5554","stableDeviceId":"emulator-5554","retryable":true,
          "recoveryWindowRemainingMs":5000,
          "recovery":{"action":"acquire_replacement_session","tools":["getAndroid","getApple"]}}}""",
      ),
      "session_recovery_pending",
      "Cannot safely recover session test-session",
    )
  }

  @Test
  fun `tool error response preserves nested error code and message`() {
    assertEnvelopeFailure(
      payload(
        """{"success":false,"message":"Invalid arguments",
          "error":{"code":"invalid_arguments","message":"Invalid arguments"}}""",
      ),
      "invalid_arguments",
      "Invalid arguments",
    )
  }

  @Test
  fun `shutdown is retried until retries are exhausted`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(shutdownPayload(), isError = true),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertEquals(false, result.success)
    assertTrue(result.errorMessage.contains("daemon_shutting_down"))
    assertEquals(3, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `current retryable session ownership loss is retried`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(sessionOwnershipLostPayload(), isError = true),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `non retryable device loss is not retried`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(deviceLostPayload(), isError = true),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `only boolean true retryable opts into retries`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload("""{"error":{"message":"Rejected","retryable":"true"}}"""),
        isError = true,
      ),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `genuine executePlan success passes`() {
    fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(successPayload()))

    val result = executePlan()

    assertTrue(result.success)
    assertEquals(0, result.exitCode)
    assertEquals("", result.errorMessage)
  }

  @Test
  fun `plan parameters reach the daemon exactly as supplied whatever characters they contain`() {
    fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(successPayload()))
    val quoted = "C:\\temp#1 \"x\" ' \${plain}"
    val plain = "shoes #1: size\nlarge"

    val result =
      AutoMobilePlanExecutor.execute(
        "test-plans/parameter-substitution.yaml",
        mapOf("quoted" to quoted, "plain" to plain),
        AutoMobilePlanExecutionOptions(),
      )

    assertTrue(result.errorMessage, result.success)
    val raw =
      fakeDaemonClient.lastExecutePlanArguments
        ?.get("planContent")
        ?.jsonPrimitive
        ?.content
        .orEmpty()
    val sent = String(java.util.Base64.getDecoder().decode(raw.removePrefix("base64:")))
    val steps =
      (Yaml(SafeConstructor(LoaderOptions())).load<Any?>(sent) as Map<*, *>)["steps"] as List<*>
    assertEquals(2, steps.size)
    assertEquals(quoted, (steps[0] as Map<*, *>)["text"])
    assertEquals(plain, (steps[1] as Map<*, *>)["text"])
  }

  @Test
  fun `structured executePlan success passes`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse(
        id = "test",
        type = "mcp_response",
        success = true,
        result = JsonObject(mapOf("structuredContent" to successPayload())),
      ),
    )

    assertTrue(executePlan().success)
  }

  @Test
  fun `structured retryable shutdown is retried and fails`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse(
        id = "test",
        type = "mcp_response",
        success = true,
        result =
          JsonObject(
            mapOf("structuredContent" to shutdownPayload(), "isError" to JsonPrimitive(true)),
          ),
      ),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(false, result.success)
    assertTrue(result.errorMessage.contains("daemon_shutting_down"))
    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `failed step preserves the existing error message`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload(
          """{"success":false,"executedSteps":1,"totalSteps":2,
            "failedStep":{"stepIndex":1,"tool":"tapOn","error":"Element not found"},
            "error":"Element not found","platform":"android","deviceId":"emulator-5554"}""",
        ),
      ),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(
      "AutoMobile plan execution failed with exit code 1\nErrors: " +
        "Test plan execution failed at step 2 (tapOn):\n  Error: Element not found\n  Executed: 1/2 steps",
      result.errorMessage,
    )
  }

  @Test
  fun `missing success without isError fails`() {
    assertEnvelopeFailure(
      payload("""{"executedSteps":0,"totalSteps":0}"""),
      "success",
      isError = false,
    )
  }

  @Test
  fun `non boolean success fails`() {
    for (value in listOf("\"true\"", "1", "null", "{}", "[]")) {
      assertEnvelopeFailure(payload("""{"success":$value}"""), "success", isError = false)
    }
  }

  @Test
  fun `isError overrides a success payload`() {
    assertEnvelopeFailure(successPayload(), "error")
  }

  @Test
  fun `error field overrides boolean success`() {
    assertEnvelopeFailure(
      payload("""{"success":true,"error":{"code":"rejected","message":"Rejected by daemon"}}"""),
      "rejected",
      "Rejected by daemon",
      isError = false,
    )
  }

  @Test
  fun `malformed JSON fails in the parser with the daemon text`() {
    fakeDaemonClient.setResponse("executePlan", buildTextResponse("{malformed"))

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, result.exitCode)
    assertTrue(result.errorMessage.contains("Malformed daemon result"))
    assertTrue(result.errorMessage.contains("{malformed"))
  }

  @Test
  fun `plain tool error text fails with the daemon message`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildTextResponse("Error: Rejected by daemon", isError = true),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, result.exitCode)
    assertTrue(result.errorMessage.contains("Error: Rejected by daemon"))
  }

  @Test
  fun `missing payload fails`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse(id = "test", type = "mcp_response", success = true),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertTrue(result.errorMessage.contains("Daemon returned empty result"))
  }

  @Test
  fun `non object payload fails`() {
    fakeDaemonClient.setResponse("executePlan", buildTextResponse("[]"))

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, result.exitCode)
    assertTrue(result.errorMessage.contains("Unexpected daemon response format"))
  }

  // The envelope below was produced by the real TypeScript PlanExecutionOrchestrator/PlanExecutor
  // (test/server/executePlanToolResultsCapture.test.ts pins it): a 3-step plan whose step 0 is a
  // `tapOn { selectionStrategy: random }`, step 1 an optional tapOn that failed and was skipped,
  // and step 2 a plain tapOn. Hand-written `toolResults` envelopes hid #10090 for a year.
  private fun capturedToolResultsResponse(): DaemonResponse {
    val text =
      checkNotNull(javaClass.classLoader.getResource("captured/execute-plan-tool-results.json"))
        .readText()
    val result = json.parseToJsonElement(text) as JsonObject
    return DaemonResponse(id = "captured", type = "mcp_response", success = true, result = result)
  }

  @Test
  fun `captured executePlan response yields per-step results addressed by plan step index`() {
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val result = executePlan()

    assertTrue(result.success)
    assertEquals(
      "executePlan",
      fakeDaemonClient.toolSelectionArguments.single()["toolName"]?.jsonPrimitive?.content,
    )
    assertEquals(listOf(0, 2), result.toolResults.map { it.stepIndex })
    assertEquals("Row 7", result.getSelection(0))
    assertEquals("Confirm", result.getSelection(2))
    assertEquals("tapOn", result.getToolResult(0)?.toolName)
    assertEquals(true, result.getToolResult(0)?.success)
  }

  @Test
  fun `a skipped optional step has no tool result and its index is not shifted onto a later step`() {
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val result = executePlan()

    assertNull(result.getToolResult(1))
    assertNull(result.getToolResultEntry(1))
    assertNull(result.getErrorToolResult(1))
    assertNull(result.getSelection(1))
    assertNull(result.getSelection(3))
  }

  @Test
  fun `getTypedResponse returns the captured tapOn response`() {
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val tapOnResponse = executePlan().getTypedResponse<TapOnResponse>(0)

    assertNotNull(tapOnResponse)
    assertEquals("Row 7", tapOnResponse?.selectedElement?.text)
    assertEquals("random", tapOnResponse?.selectedElement?.selectionStrategy)
    assertEquals(6, tapOnResponse?.selectedElement?.indexInMatches)
    assertEquals(12, tapOnResponse?.selectedElement?.totalMatches)
  }

  @Test
  fun `retries a transient executePlan selection failure`() {
    fakeDaemonClient.queueToolSelectionResponse(
      DaemonResponse(
        id = "tool-selection-timeout",
        type = "mcp_response",
        success = false,
        error = "daemon request timeout",
      ),
    )
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(JsonObject(mapOf("success" to JsonPrimitive(true)))),
    )
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1))

    assertTrue(result.success)
    assertEquals(2, fakeDaemonClient.toolSelectionArguments.size)
  }

  @Test
  fun `fails when the exact-tool control is unavailable`() {
    fakeDaemonClient.queueToolSelectionResponse(
      DaemonResponse(
        id = "tool-selection-unknown-tool",
        type = "mcp_response",
        success = false,
        error = "Unknown tool: setToolEnabled",
      ),
    )
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(JsonObject(mapOf("success" to JsonPrimitive(true)))),
    )

    val result = executePlan()

    assertEquals(false, result.success)
    assertEquals(1, fakeDaemonClient.toolSelectionArguments.size)
  }

  @Test
  fun `parsing errors are handled gracefully`() {
    val step = JsonObject(emptyMap())

    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        JsonObject(
          mapOf(
            "success" to JsonPrimitive(true),
            "toolResults" to JsonArray(listOf(step)),
          ),
        ),
      ),
    )

    val result = executePlan()

    assertEquals(1, result.toolResults.size)
    val errorResult = result.toolResults[0] as? ErrorToolResult
    assertNotNull(errorResult)
    assertTrue(errorResult?.errorMessage?.contains("Missing tool name") == true)
  }

  @Test
  fun `resolveCaptureObserveSteps reads system property and normalizes`() {
    val cases =
      listOf(
        "summary" to "summary",
        "full" to "full",
        "  SUMMARY  " to "summary",
        "FULL" to "full",
        "bogus" to null,
        "" to null,
      )
    for ((input, expected) in cases) {
      System.setProperty(AutoMobilePlanExecutor.CAPTURE_OBSERVE_STEPS_PROPERTY, input)
      try {
        assertEquals(
          "input=\"$input\"",
          expected,
          AutoMobilePlanExecutor.resolveCaptureObserveSteps(),
        )
      } finally {
        System.clearProperty(AutoMobilePlanExecutor.CAPTURE_OBSERVE_STEPS_PROPERTY)
      }
    }
  }

  @Test
  fun `resolveCaptureObserveSteps returns null when property is unset`() {
    System.clearProperty(AutoMobilePlanExecutor.CAPTURE_OBSERVE_STEPS_PROPERTY)
    // Cannot set env vars from tests; this falls through to the env-var branch which is also unset
    // in the test JVM, so a null result here also covers the "neither set" case.
    assertNull(AutoMobilePlanExecutor.resolveCaptureObserveSteps())
  }

  private fun executePlan(
    options: AutoMobilePlanExecutionOptions = AutoMobilePlanExecutionOptions(),
  ): AutoMobilePlanExecutionResult {
    return AutoMobilePlanExecutor.execute(
      "test-plans/launch-clock-app.yaml",
      emptyMap(),
      options,
    )
  }

  private fun payload(text: String): JsonObject = json.parseToJsonElement(text) as JsonObject

  // Current server builders: sessionOwnershipLostPayload, deviceLossOutcomeFromError,
  // daemonShuttingDownMcpOutcome, and PlanExecutionOrchestrator.execute.
  private fun sessionOwnershipLostPayload(): JsonObject =
    payload(
      """{"error":{"code":"session_ownership_lost","message":"Session released",
      "sessionUuid":"test-session","reason":"explicit","retryable":true,
      "recovery":{"action":"acquire_replacement_session","tools":["getAndroid","getApple"]}}}""",
    )

  // Shape of shapeToolCallError for an InputDeviceOwnedError
  // (test/server/toolRegistry.deviceOwnership).
  private fun deviceOwnedPayload(): JsonObject =
    payload(
      """{"success":false,"error":"executePlan refused: device 'emulator-5554' is held by another session.","code":"device_owned_by_other_session","deviceId":"emulator-5554","retryable":false}""",
    )

  private fun deviceLostPayload(): JsonObject =
    payload(
      """{"code":"device_lost","deviceId":"emulator-5554","sessionUuid":"test-session",
      "reason":"confirmed-unavailable"}""",
    )

  private fun shutdownPayload(): JsonObject =
    payload(
      """{"error":{"code":"daemon_shutting_down","message":"Daemon is shutting down","retryable":true}}""",
    )

  private fun successPayload(): JsonObject =
    payload(
      """{"success":true,"executedSteps":1,"totalSteps":1,"platform":"android","deviceId":"emulator-5554"}""",
    )

  private fun assertEnvelopeFailure(
    payload: JsonObject,
    vararg messages: String,
    isError: Boolean = true,
  ) {
    fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(payload, isError))

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, result.exitCode)
    for (message in messages) {
      assertTrue(result.errorMessage, result.errorMessage.contains(message))
    }
  }

  private fun buildDaemonResponse(payload: JsonObject, isError: Boolean = false): DaemonResponse =
    buildTextResponse(json.encodeToString(JsonElement.serializer(), payload), isError)

  private fun buildTextResponse(text: String, isError: Boolean = false): DaemonResponse {
    val result =
      JsonObject(
        mapOf(
          "content" to
            JsonArray(
              listOf(
                JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text))),
              ),
            ),
          "isError" to JsonPrimitive(isError),
        ),
      )
    return DaemonResponse(id = "test", type = "mcp_response", success = true, result = result)
  }
}

private class FakeDaemonToolClient : DaemonToolClient {
  private val responses = mutableMapOf<String, DaemonResponse>()
  private val toolSelectionResponses = mutableListOf<DaemonResponse>()
  val toolSelectionArguments = mutableListOf<JsonObject>()
  var executePlanCalls = 0
    private set

  var lastExecutePlanArguments: JsonObject? = null
    private set

  override var sessionUuid: String = "test-session"

  fun setResponse(toolName: String, response: DaemonResponse) {
    responses[toolName] = response
  }

  private val executePlanQueue = ArrayDeque<DaemonResponse>()

  /** Responses served once each, in order, before falling back to [setResponse]. */
  fun queueExecutePlanResponse(response: DaemonResponse) {
    executePlanQueue.addLast(response)
  }

  fun queueToolSelectionResponse(response: DaemonResponse) {
    toolSelectionResponses.add(response)
  }

  override fun callTool(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    if (toolName == "setToolEnabled") {
      toolSelectionArguments.add(arguments)
      return toolSelectionResponses.removeFirstOrNull()
        ?: DaemonResponse(id = "tool-selection", type = "mcp_response", success = true)
    }
    if (toolName == "executePlan") {
      executePlanCalls++
      lastExecutePlanArguments = arguments
      executePlanQueue.removeFirstOrNull()?.let {
        return it
      }
    }
    return responses[toolName]
      ?: throw IllegalStateException("No response configured for tool: $toolName")
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    throw IllegalStateException("readResource not configured for $uri")
  }
}

private class FakeDeviceChecker(private val devicesAvailable: Boolean) : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable(): Boolean = devicesAvailable

  override fun getDeviceCount(): Int = if (devicesAvailable) 1 else 0
}

private class FakeDaemonHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
