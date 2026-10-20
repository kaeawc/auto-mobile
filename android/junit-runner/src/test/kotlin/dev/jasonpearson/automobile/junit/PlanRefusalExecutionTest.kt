package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

internal class PlanRefusalExecutionTest : PlanExecutorTestFixture() {
  @Test
  fun `non retryable capacity exhaustion is not waited on and exhausted waits report the code`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(capacityPayload("capacity_exhausted", false, null), isError = true),
    )
    assertEquals(false, executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false)).success)
    assertEquals(emptyList<Long>(), waits)

    timings = timings.copy(deviceOwnedWaitBudgetMs = 600L)
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(capacityPayload("capacity_exhausted", true, null), isError = true),
    )
    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))
    assertEquals(listOf(500L, 100L), waits)
    assertTrue(result.errorMessage, result.errorMessage.contains("capacity_exhausted"))
  }

  @Test
  fun `a device another daemon claims is waited on like a held device`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.queueExecutePlanResponse(
      buildDaemonResponse(otherDaemonPayload(), isError = true),
    )
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(true, result.success)
    assertEquals(listOf(2000L), waits)
    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a device that is shutting down is waited on like a held device`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.queueExecutePlanResponse(
      buildDaemonResponse(shuttingDownDevicePayload(), isError = true),
    )
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(true, result.success)
    assertEquals(listOf(500L), waits)
    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a held device that never frees fails with a clear error after the wait budget`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    timings = timings.copy(deviceOwnedWaitBudgetMs = 3_000L)
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
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
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
    timings = timings.copy(retryBackoffMs = 0L)

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertEquals(false, result.success)
    assertTrue(result.errorMessage.contains("daemon_shutting_down"))
    assertEquals(3, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `terminal session refusal is retried under a new session not the same uuid`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(otherDaemonTerminalSessionPayload(), isError = true),
    )
    timings = timings.copy(retryBackoffMs = 0L)

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `terminal session refusal without nextAction is not retried`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload(
          """{"error":{"code":"session_ownership_lost","message":"gone","retryable":false}}""",
        ),
        isError = true,
      ),
    )
    timings = timings.copy(retryBackoffMs = 0L)

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 2, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `current retryable session ownership loss is retried`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(sessionOwnershipLostPayload(), isError = true),
    )
    timings = timings.copy(retryBackoffMs = 0L)

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
    timings = timings.copy(retryBackoffMs = 0L)

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
    timings = timings.copy(retryBackoffMs = 0L)

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
      AutoMobilePlan("test-plans/parameter-substitution.yaml", collaborators) {
          "quoted" to quoted
          "plain" to plain
        }
        .execute()

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
}
