package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * How the runner consumes the daemon's `executePlan` envelope for the two plan-step verdicts the
 * daemon added together with the new request-deadline derivation:
 * - a nested `executePlan` step that fails is the OUTER plan's failed step (#10172);
 * - a step whose tool answered `status: "unsupported"` fails with the tool's own text (#10175).
 *
 * Both payloads are real captures (`captured/execute-plan-nested-failed-step.json`,
 * `captured/execute-plan-unsupported-step.json`, written by
 * test/server/executePlanToolResultsCapture.test.ts), so a change to the daemon's envelope shape
 * fails there first and a runner-side parsing change fails here.
 *
 * It also pins how long the runner waits for `executePlan` (#10173): the daemon now derives a
 * request deadline from a `base64:` plan's own step budgets, but the runner's socket wait is
 * `max(options.timeoutMs, MIN_EXECUTE_PLAN_TIMEOUT_MS)` and does not follow the plan.
 */
class PlanFailureShapesAndTimeoutTest {
  private lateinit var daemon: ShapesRecordingDaemon

  @Before
  fun setup() {
    daemon = ShapesRecordingDaemon()
    DaemonSocketClientManager.testClient = daemon
    AutoMobileSharedUtils.testDeviceChecker = ShapesDeviceChecker()
    DaemonHeartbeat.testController = ShapesHeartbeat()
    AutoMobilePlanExecutor.testAgent =
      AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = false))
    AutoMobilePlanExecutor.retryBackoffMs = 0L
    System.setProperty("automobile.ci.mode", "false")
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testClient = null
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    AutoMobilePlanExecutor.retryBackoffMs = 2000L
    System.clearProperty("automobile.ci.mode")
  }

  // ── #10172: a failing nested executePlan step ─────────────────────────────

  @Test
  fun `a failing nested executePlan step fails the outer plan at that step with the inner error`() {
    daemon.executePlanResponses += captured("execute-plan-nested-failed-step.json")

    val result = executePlan()

    assertFalse(result.success)
    assertEquals(1, result.exitCode)
    assertTrue(result.errorMessage, result.errorMessage.contains("step 2 (executePlan)"))
    assertTrue(result.errorMessage, result.errorMessage.contains("Element not found"))
    assertTrue(result.errorMessage, result.errorMessage.contains("Executed: 1/3 steps"))
  }

  @Test
  fun `the nested failure keeps the outer plan's per-step results addressed by plan step index`() {
    daemon.executePlanResponses += captured("execute-plan-nested-failed-step.json")

    val result = executePlan()

    // Only the step that completed before the nested plan is reported; the failed nested step has
    // no result entry (its failure is in the message), and nothing is shifted onto a later index.
    assertEquals(listOf(0), result.toolResults.map { it.stepIndex })
    assertEquals("Row 7", result.getSelection(0))
    assertNull(result.getToolResultEntry(1))
    assertNull(result.getToolResultEntry(2))
  }

  // ── #10175: a step the tool did not perform ───────────────────────────────

  @Test
  fun `a setPosture unsupported step fails the plan and the message carries the tool's own text`() {
    daemon.executePlanResponses += captured("execute-plan-unsupported-step.json")

    val result = executePlan()

    assertFalse(result.success)
    assertTrue(result.errorMessage, result.errorMessage.contains("step 2 (setPosture)"))
    assertTrue(
      result.errorMessage,
      result.errorMessage.contains(
        "Setting a hinge angle needs the Android emulator console; " +
          "physical Android devices are unsupported. Nothing was changed."
      ),
    )
    assertEquals(listOf(0), result.toolResults.map { it.stepIndex })
  }

  @Test
  fun `a plan failed by an unsupported step is not retried as a transient error`() {
    daemon.executePlanResponses += captured("execute-plan-unsupported-step.json")
    daemon.executePlanResponses += captured("execute-plan-unsupported-step.json")

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertFalse(result.success)
    assertEquals(1, daemon.executePlanTimeouts.size)
  }

  // ── #10173: the runner's own wait for executePlan ─────────────────────────

  @Test
  fun `the runner waits the ten minute floor for executePlan whatever the plan asks for`() {
    daemon.executePlanResponses += successEnvelope()

    executePlan(AutoMobilePlanExecutionOptions(timeoutMs = 30_000L))

    // The daemon derives max(600_000, summed step budgets + 30_000) up to 1_800_000 for a base64
    // plan (src/daemon/mcpRequestTimeout.ts). The runner's wait is this fixed number, so a plan
    // whose steps legitimately need longer outlives it: raise AutoMobilePlanExecutionOptions
    // .timeoutMs for such plans.
    assertEquals(listOf(600_000L), daemon.executePlanTimeouts)
    assertEquals(MIN_EXECUTE_PLAN_TIMEOUT_MS, daemon.executePlanTimeouts.single())
  }

  @Test
  fun `a caller who raises the timeout above the floor has it used for executePlan`() {
    daemon.executePlanResponses += successEnvelope()

    executePlan(AutoMobilePlanExecutionOptions(timeoutMs = 1_500_000L))

    assertEquals(listOf(1_500_000L), daemon.executePlanTimeouts)
  }

  // ── #10169: a daemon that stays unreachable after the recovery attempt ────

  @Test
  fun `an executePlan attempt that could not reach the restarted daemon is retried`() {
    daemon.executePlanFailures += DaemonUnavailableException(UNREACHABLE_AFTER_RESTART)
    daemon.executePlanResponses += successEnvelope()

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    // The failure is raised while connecting, before the attempt's request is written, so the
    // retry cannot re-run a step that attempt already applied.
    assertTrue(result.errorMessage, result.success)
    assertEquals(2, daemon.executePlanTimeouts.size)
  }

  @Test
  fun `a connection lost while the plan was running is not retried`() {
    daemon.executePlanFailures +=
      DaemonUnavailableException("Daemon request failed: Daemon socket closed")
    daemon.executePlanResponses += successEnvelope()

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    // The request may already have applied steps; re-sending the whole plan would repeat them.
    assertFalse(result.success)
    assertEquals(1, daemon.executePlanTimeouts.size)
  }

  @Test
  fun `a daemon that stays unreachable fails once retries are used up`() {
    repeat(3) {
      daemon.executePlanFailures += DaemonUnavailableException(UNREACHABLE_AFTER_RESTART)
    }

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertFalse(result.success)
    assertTrue(result.errorMessage, result.errorMessage.contains("not reachable"))
    assertEquals(3, daemon.executePlanTimeouts.size)
  }

  private fun executePlan(
    options: AutoMobilePlanExecutionOptions = AutoMobilePlanExecutionOptions(aiAssistance = false)
  ): AutoMobilePlanExecutionResult =
    AutoMobilePlanExecutor.execute("test-plans/launch-clock-app.yaml", emptyMap(), options)

  private fun captured(name: String): DaemonResponse {
    val text = checkNotNull(javaClass.classLoader.getResource("captured/$name")).readText()
    val result = Json.parseToJsonElement(text) as JsonObject
    return DaemonResponse(id = "captured", type = "mcp_response", success = true, result = result)
  }

  private fun successEnvelope(): DaemonResponse {
    val text = """{"success":true,"executedSteps":1,"totalSteps":1}"""
    val result =
      JsonObject(
        mapOf(
          "content" to
            kotlinx.serialization.json.JsonArray(
              listOf(
                JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text)))
              )
            )
        )
      )
    return DaemonResponse(id = "ok", type = "mcp_response", success = true, result = result)
  }

  private companion object {
    // The message connectWithDaemonRecovery raises after its bounded post-recovery connects.
    const val UNREACHABLE_AFTER_RESTART =
      "AutoMobile daemon is not reachable at /tmp/auto-mobile-daemon.sock even after attempting " +
        "to restart it: Connection refused"
  }
}

/**
 * Daemon fake that records the timeout every `executePlan` call was given. Queued failures are
 * thrown (as the socket client does) before queued responses are returned, in call order.
 */
private class ShapesRecordingDaemon : DaemonToolClient {
  val executePlanResponses = ArrayDeque<DaemonResponse>()
  val executePlanFailures = ArrayDeque<DaemonUnavailableException>()
  val executePlanTimeouts = mutableListOf<Long>()
  override var sessionUuid: String = "shapes-session"

  override fun callTool(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse {
    if (toolName == "setToolEnabled") {
      return DaemonResponse(id = "enable", type = "mcp_response", success = true)
    }
    check(toolName == "executePlan") { "unexpected tool $toolName" }
    executePlanTimeouts.add(timeoutMs)
    executePlanFailures.removeFirstOrNull()?.let {
      throw it
    }
    return checkNotNull(executePlanResponses.removeFirstOrNull()) { "no response queued" }
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    throw IllegalStateException("readResource not configured for $uri")
  }
}

private class ShapesDeviceChecker : DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable() = true

  override fun getDeviceCount() = 1
}

private class ShapesHeartbeat : DaemonHeartbeatController {
  override fun startBackground(intervalMs: Long) = java.io.Closeable {}

  override fun registerSession(sessionId: String) = Unit

  override fun unregisterSession(sessionId: String) = Unit
}
