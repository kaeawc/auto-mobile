package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every executePlan attempt runs under a session the daemon issued with getAndroid, never a
 * runner-minted UUID the daemon refuses as never issued (#17953, #6069).
 */
internal class PlanSessionAcquisitionTest : PlanExecutorTestFixture() {

  private val noAi = AutoMobilePlanExecutionOptions(aiAssistance = false)

  private fun useAcquirer(acquirer: FakePlanSessionAcquirer) {
    collaborators = collaborators.copy(sessionAcquirerFactory = { acquirer })
  }

  @Test
  fun `the plan runs under the issued session on the ANDROID_SERIAL device and releases it`() {
    val acquirer = FakePlanSessionAcquirer()
    useAcquirer(acquirer)
    fakeEnv[PlanDeviceSelection.ANDROID_SERIAL_ENV] = "emulator-5562"
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val result = executePlan(noAi)

    assertTrue(result.errorMessage, result.success)
    assertEquals(listOf<String?>("emulator-5562"), acquirer.acquiredDeviceIds)
    assertEquals(
      JsonPrimitive("issued-1"),
      fakeDaemonClient.toolSelectionArguments.single()["sessionUuid"],
    )
    assertEquals(
      JsonPrimitive("issued-1"),
      fakeDaemonClient.lastExecutePlanArguments?.get("sessionUuid"),
    )
    assertEquals(listOf("issued-1"), acquirer.released)
  }

  @Test
  fun `a failed acquisition fails the test with its reason and never calls executePlan`() {
    val refusal =
      buildDaemonResponse(
        payload("""{"success":false,"error":"Device emulator-5562 is held by another session"}"""),
        isError = true,
      )
    val acquisition =
      DaemonPlanSessionAcquirer.interpretAcquisition(refusal, "emulator-5562", json)
        as PlanSessionAcquisition.Failed
    val acquirer = FakePlanSessionAcquirer(failures = mapOf(0 to acquisition))
    useAcquirer(acquirer)
    fakeEnv[PlanDeviceSelection.ANDROID_SERIAL_ENV] = "emulator-5562"

    val result = executePlan(noAi)

    assertFalse(result.success)
    assertEquals(0, fakeDaemonClient.executePlanCalls)
    assertTrue(fakeDaemonClient.toolSelectionArguments.isEmpty())
    assertTrue(
      result.output,
      result.output.contains("Could not acquire emulator-5562 with getAndroid"),
    )
    assertTrue(result.output, result.output.contains("held by another session"))
    assertTrue(result.output, result.output.contains(FAKE_DAEMON_SOCKET))
    assertTrue("nothing was issued, so nothing is released", acquirer.released.isEmpty())
  }

  @Test
  fun `a failed plan without recovery releases its issued session`() {
    val acquirer = FakePlanSessionAcquirer()
    useAcquirer(acquirer)
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(payload("""{"success":false,"error":"step 1 failed"}"""), isError = true),
    )

    val result = executePlan(noAi)

    assertFalse(result.success)
    assertEquals(listOf("issued-1"), acquirer.released)
  }

  @Test
  fun `a retry acquires a fresh session after releasing the failed one`() {
    timings = PlanExecutorTimings(retryBackoffMs = 0L)
    val acquirer = FakePlanSessionAcquirer()
    useAcquirer(acquirer)
    fakeDaemonClient.queueExecutePlanResponse(
      DaemonResponse(id = "", type = "mcp_response", success = false, error = "Request timed out"),
    )
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val result = executePlan(noAi.copy(maxRetries = 1))

    assertTrue(result.errorMessage, result.success)
    assertEquals(
      listOf(
        "acquire:null",
        "issued:issued-1",
        "release:issued-1",
        "acquire:null",
        "issued:issued-2",
        "release:issued-2",
      ),
      acquirer.events,
    )
    assertEquals(
      JsonPrimitive("issued-2"),
      fakeDaemonClient.lastExecutePlanArguments?.get("sessionUuid"),
    )
  }

  @Test
  fun `a refused setToolEnabled releases the session it was issued`() {
    val acquirer = FakePlanSessionAcquirer()
    useAcquirer(acquirer)
    fakeDaemonClient.queueToolSelectionResponse(
      DaemonResponse(id = "", type = "mcp_response", success = false, error = "not allowed"),
    )

    val result = executePlan(noAi)

    assertFalse(result.success)
    assertEquals(0, fakeDaemonClient.executePlanCalls)
    assertEquals(listOf("issued-1"), acquirer.released)
  }
}

/** The daemon-backed acquirer: what it sends, and how it reads the getAndroid answer. */
internal class DaemonPlanSessionAcquirerTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `reads the issued runtime session uuid from the result text`() {
    val daemon = AcquisitionDaemon(textResult("""{"runtime":{"session":{"sessionUuid":"s-1"}}}"""))

    val acquisition = DaemonPlanSessionAcquirer(daemon).acquire("emulator-5562", 1_000L)

    assertEquals(PlanSessionAcquisition.Acquired("s-1"), acquisition)
    assertEquals("getAndroid", daemon.toolName)
    assertEquals(JsonPrimitive("emulator-5562"), daemon.arguments?.get("deviceId"))
  }

  @Test
  fun `without a device it acquires the first free booted device the daemon lists`() {
    val daemon =
      AcquisitionDaemon(
        textResult("""{"runtime":{"session":{"sessionUuid":"s-1"}}}"""),
        booted =
          bootedDevices(
            """{"deviceId":"emulator-5554","session":{"sessionUuid":"other","ownership":"owned"}}""",
            """{"deviceId":"emulator-5556","connection":{"state":"offline","adbState":"offline"}}""",
            """{"deviceId":"emulator-5558","heldBy":"other_daemon"}""",
            """{"deviceId":"emulator-5562","session":null,"poolStatus":"idle"}""",
          ),
      )

    val acquisition = DaemonPlanSessionAcquirer(daemon).acquire(null, 1_000L)

    assertEquals(PlanSessionAcquisition.Acquired("s-1"), acquisition)
    assertEquals(listOf(DaemonPlanSessionAcquirer.BOOTED_ANDROID_URI), daemon.reads)
    assertEquals(JsonPrimitive("emulator-5562"), daemon.arguments?.get("deviceId"))
  }

  @Test
  fun `when every online device is held it asks for the first so the daemon refusal waits`() {
    val choice =
      DaemonPlanSessionAcquirer.chooseBootedDevice(
        json
          .parseToJsonElement(
            bootedDevices(
              """{"deviceId":"emulator-5554","session":{"sessionUuid":"other","ownership":"owned"}}""",
              """{"deviceId":"emulator-5556","poolStatus":"assigned"}""",
            ),
          )
          .let { (it as JsonObject)["devices"] as JsonArray },
      )

    assertEquals(DaemonPlanSessionAcquirer.BootedDeviceChoice.Chosen("emulator-5554"), choice)
  }

  @Test
  fun `with no booted device it fails without calling getAndroid`() {
    val daemon = AcquisitionDaemon(textResult("{}"), booted = bootedDevices())

    val acquisition = DaemonPlanSessionAcquirer(daemon).acquire(null, 1_000L)

    val parsed = (acquisition as PlanSessionAcquisition.Failed).parsed
    assertTrue(parsed.errorMessage, parsed.errorMessage.contains("no online booted Android device"))
    assertTrue(parsed.errorMessage, parsed.errorMessage.contains("ANDROID_SERIAL"))
    assertEquals(null, daemon.toolName)
  }

  @Test
  fun `a result without a session is a failure that says so`() {
    val acquisition =
      DaemonPlanSessionAcquirer.interpretAcquisition(
        textResult("""{"runtime":{"session":null}}"""),
        null,
        json,
      )

    val parsed = (acquisition as PlanSessionAcquisition.Failed).parsed
    assertFalse(parsed.success)
    assertTrue(parsed.errorMessage, parsed.errorMessage.contains("an Android device"))
    assertTrue(parsed.errorMessage, parsed.errorMessage.contains("runtime.session.sessionUuid"))
  }

  @Test
  fun `a typed refusal frame keeps its code for the device wait`() {
    val frame =
      DaemonResponse(
        id = "",
        type = "mcp_response",
        success = false,
        error = "held",
        code = JsonPrimitive("device_owned_by_other_session"),
        retryable = JsonPrimitive(true),
      )

    val failed =
      DaemonPlanSessionAcquirer.interpretAcquisition(frame, "emulator-5562", json)
        as PlanSessionAcquisition.Failed

    assertEquals("device_owned_by_other_session", failed.parsed.code)
    assertTrue(failed.parsed.retryable)
    assertEquals("Could not acquire emulator-5562 with getAndroid: held", failed.response.error)
  }

  @Test
  fun `release sends daemon releaseSession for the issued session`() {
    val daemon = AcquisitionDaemon(textResult("{}"))

    DaemonPlanSessionAcquirer(daemon).release("s-1")

    assertEquals(
      listOf("daemon/releaseSession" to JsonPrimitive("s-1")),
      daemon.methods.map { it.first to it.second["sessionId"] },
    )
  }

  private fun textResult(text: String): DaemonResponse =
    DaemonResponse(
      id = "a",
      type = "mcp_response",
      success = true,
      result =
        JsonObject(
          mapOf(
            "content" to
              JsonArray(
                listOf(
                  JsonObject(
                    mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text)),
                  ),
                ),
              ),
          ),
        ),
    )

  /** A `automobile:devices/booted/android` read whose devices carry these `runtime` objects. */
  private fun bootedDevices(vararg runtimes: String): String =
    """{"devices":[${runtimes.joinToString(",") { """{"runtime":$it}""" }}]}"""

  private class AcquisitionDaemon(
    private val answer: DaemonResponse,
    private val booted: String? = null,
  ) : DaemonToolClient {
    val reads = mutableListOf<String>()
    var toolName: String? = null
    var arguments: JsonObject? = null
    val methods = mutableListOf<Pair<String, JsonObject>>()
    override var sessionUuid: String = "client"

    override fun callTool(
      toolName: String,
      arguments: JsonObject,
      timeoutMs: Long,
    ): DaemonResponse {
      this.toolName = toolName
      this.arguments = arguments
      return answer
    }

    override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
      reads.add(uri)
      val text = booted ?: throw IllegalStateException("unexpected read of $uri")
      val content = JsonObject(mapOf("uri" to JsonPrimitive(uri), "text" to JsonPrimitive(text)))
      return DaemonResponse(
        id = "r",
        type = "resource_response",
        success = true,
        result = JsonObject(mapOf("contents" to JsonArray(listOf(content)))),
      )
    }

    override fun callDaemonMethod(
      method: String,
      params: JsonObject,
      timeoutMs: Long,
    ): DaemonResponse {
      methods.add(method to params)
      return DaemonResponse(id = "m", type = "daemon_response", success = true)
    }
  }
}
