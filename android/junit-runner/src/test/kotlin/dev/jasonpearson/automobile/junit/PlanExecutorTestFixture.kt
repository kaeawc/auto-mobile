package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before

internal abstract class PlanExecutorTestFixture {

  protected var timings = PlanExecutorTimings()
  protected lateinit var collaborators: PlanExecutorCollaborators
  protected val json = Json { ignoreUnknownKeys = true }
  protected lateinit var fakeDaemonClient: FakeDaemonToolClient
  protected lateinit var fakeDeviceChecker: FakeDeviceChecker

  @Before
  fun setup() {
    fakeDaemonClient = FakeDaemonToolClient()
    fakeDeviceChecker = FakeDeviceChecker(devicesAvailable = true)
    val agent =
      AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = false))
    collaborators =
      PlanExecutorCollaborators(
        agent = { agent },
        deviceChecker = fakeDeviceChecker,
        daemon = fakeDaemonClient,
        heartbeat = FakeDaemonHeartbeat(),
      )
  }

  protected fun recoveryFixtureDir(): File {
    var current: File? = File("").absoluteFile
    while (current != null) {
      val dir = File(current, "test/fixtures/refusal-wire")
      if (dir.isDirectory) return dir
      current = current.parentFile
    }
    error("refusal fixtures not found")
  }

  protected fun recoveryPayload(file: File): JsonObject {
    val result = json.parseToJsonElement(file.readText()).jsonObject.getValue("result").jsonObject
    return payload(
      result
        .getValue("content")
        .jsonArray
        .first()
        .jsonObject
        .getValue("text")
        .jsonPrimitive
        .content,
    )
  }

  protected fun assertUnhealthyMessage(message: String, wire: JsonObject) {
    val evidence = (wire["details"] as? JsonObject) ?: (wire["error"] as? JsonObject) ?: wire
    assertTrue(message, message.contains("device_unhealthy"))
    val daemonError =
      (wire["error"] as? JsonPrimitive)?.content ?: (evidence["message"] as? JsonPrimitive)?.content
    assertTrue(message, message.contains(daemonError!!))
    val devices = evidence["devices"]?.jsonArray?.map { it.jsonObject } ?: listOf(evidence)
    val rendered =
      devices.joinToString(", ") {
        "${it.getValue("deviceId").jsonPrimitive.content} (${it.getValue("reason").jsonPrimitive.content}, ${if (it["recovering"] == JsonPrimitive(true)) "recovering" else "not recovering"})"
      }
    assertTrue(message, message.contains("Unhealthy devices: $rendered"))
  }

  // The envelope below was produced by the real TypeScript PlanExecutionOrchestrator/PlanExecutor
  // (test/server/executePlanToolResultsCapture.test.ts pins it): a 3-step plan whose step 0 is a
  // `tapOn { selectionStrategy: random }`, step 1 an optional tapOn that failed and was skipped,
  // and step 2 a plain tapOn. Hand-written `toolResults` envelopes hid #10090 for a year.
  protected fun capturedToolResultsResponse(): DaemonResponse {
    val text =
      checkNotNull(javaClass.classLoader.getResource("captured/execute-plan-tool-results.json"))
        .readText()
    val result = json.parseToJsonElement(text) as JsonObject
    return DaemonResponse(id = "captured", type = "mcp_response", success = true, result = result)
  }

  protected fun executePlan(
    options: AutoMobilePlanExecutionOptions = AutoMobilePlanExecutionOptions(),
  ): AutoMobilePlanExecutionResult {
    return PlanExecutor(collaborators.copy(timings = timings))
      .execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        options,
      )
  }

  protected fun assertEnvelopeFailure(
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
}

internal class FakeDaemonToolClient : DaemonToolClient {
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

internal class FakeDeviceChecker(private val devicesAvailable: Boolean) : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable(): Boolean = devicesAvailable

  override fun getDeviceCount(): Int = if (devicesAvailable) 1 else 0
}

internal class FakeDaemonHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
