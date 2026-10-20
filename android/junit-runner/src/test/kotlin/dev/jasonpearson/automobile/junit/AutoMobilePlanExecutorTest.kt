package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class AutoMobilePlanExecutorTest : PlanExecutorTestFixture() {
  @Test
  fun `recovery corpus waits without retries and permanent health failures include reasons`() {
    val sleeps = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { sleeps.add(it) })
    val coverage = RecoveryCorpusCoverage()
    for (file in
      recoveryFixtureDir().listFiles()!!.filter {
        it.extension == "json" && it.name != "expectations.json"
      }) {
      val wire = recoveryPayload(file)
      val (code, recovering, waits, hint) = recoveryFixtureEvidence(wire) ?: continue
      fakeDaemonClient = FakeDaemonToolClient()
      collaborators = collaborators.copy(daemon = fakeDaemonClient)
      sleeps.clear()
      fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(wire, true))
      fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))
      val result =
        executePlan(
          AutoMobilePlanExecutionOptions(maxRetries = if (waits) 0 else 2, aiAssistance = false),
        )
      assertEquals(file.name, waits, result.success)
      assertEquals(
        file.name,
        if (waits) listOf(maxOf(500L, hint ?: 0L)) else emptyList<Long>(),
        sleeps,
      )
      assertEquals(file.name, if (waits) 2 else 1, fakeDaemonClient.executePlanCalls)
      if (code == "device_unhealthy") {
        if (waits) {
          coverage.recordWait(hint)
        } else {
          coverage.recordPermanent(recovering)
          assertUnhealthyMessage(result.errorMessage, wire)
          assertTrue(
            result.errorMessage,
            result.errorMessage.contains("Replace the device with killDevice then startDevice."),
          )
        }
      }
    }
    coverage.assertCovered()
  }

  @Test
  fun `recovery give up spends exactly the bounded budget and reports recovery`() {
    for ((name, lead) in
      listOf(
        "device_unhealthy" to "Device is still being recovered",
        "session_held_by_recovery" to "Session's device is still being recovered",
      )) {
      val wire = recoveryPayload(File(recoveryFixtureDir(), "$name.json"))
      val sleeps = mutableListOf<Long>()
      timings = timings.copy(deviceOwnedSleeper = { sleeps.add(it) })
      fakeDaemonClient = FakeDaemonToolClient()
      collaborators = collaborators.copy(daemon = fakeDaemonClient)
      fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(wire, true))
      val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))
      assertEquals(false, result.success)
      assertEquals(30_000L, sleeps.sum())
      assertEquals(sleeps.size + 1, fakeDaemonClient.executePlanCalls)
      assertTrue(result.errorMessage, result.errorMessage.contains("$lead ($name)"))
      assertTrue(
        result.errorMessage,
        result.errorMessage.contains("The runner waited 30000ms for the recovery to finish."),
      )
      if (name == "device_unhealthy") assertUnhealthyMessage(result.errorMessage, wire)
    }
  }

  @Test
  fun `failed health frames wait or fail with reasons from details`() {
    val unhealthyWaitModes = mutableSetOf<Boolean>()
    for (file in
      File(recoveryFixtureDir(), "surfaces").listFiles()!!.filter {
        it.name.startsWith("socket-frame.") && it.extension == "json"
      }) {
      val wire = json.parseToJsonElement(file.readText()).jsonObject.getValue("payload").jsonObject
      val code = wire["code"]?.jsonPrimitive?.content
      if (code !in setOf("device_unhealthy", "session_held_by_recovery")) continue
      val frame =
        json.decodeFromString(
          DaemonResponse.serializer(),
          JsonObject(wire + ("id" to JsonPrimitive("frame"))).toString(),
        )
      val sleeps = mutableListOf<Long>()
      timings = timings.copy(deviceOwnedSleeper = { sleeps.add(it) })
      fakeDaemonClient = FakeDaemonToolClient()
      collaborators = collaborators.copy(daemon = fakeDaemonClient)
      fakeDaemonClient.queueExecutePlanResponse(frame)
      fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))
      val waits =
        wire["retryable"] == JsonPrimitive(true) &&
          (code == "session_held_by_recovery" ||
            (wire["details"] as? JsonObject)?.get("recovering") == JsonPrimitive(true))
      val hint = wire["retryAfterMs"]?.jsonPrimitive?.long
      if (code == "device_unhealthy") {
        unhealthyWaitModes.add(waits)
      }
      val result =
        executePlan(
          AutoMobilePlanExecutionOptions(maxRetries = if (waits) 0 else 2, aiAssistance = false),
        )
      assertEquals(waits, result.success)
      assertEquals(if (waits) listOf(maxOf(500L, hint ?: 0L)) else emptyList<Long>(), sleeps)
      assertEquals(if (waits) 2 else 1, fakeDaemonClient.executePlanCalls)
      if (!waits && code == "device_unhealthy") {
        assertUnhealthyMessage(result.errorMessage, wire)
        assertTrue(
          result.errorMessage,
          result.errorMessage.contains("Replace the device with killDevice then startDevice."),
        )
      }
    }
    assertEquals(setOf(true, false), unhealthyWaitModes)
  }

  @Test
  fun `a device held by another session is waited for with backoff then succeeds`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
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
  fun `a device still finishing cleanup is waited on like a held device`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    repeat(2) {
      fakeDaemonClient.queueExecutePlanResponse(
        buildDaemonResponse(deviceCleanupPayload(), isError = true),
      )
    }
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(true, result.success)
    // #11538: for the finalize codes retryAfterMs bounds the total wait, not each step.
    assertEquals(listOf(500L, 1000L), waits)
    assertEquals(3, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a cleanup refusal advertising the finalize cap is retried on the ordinary backoff`() {
    // #11538: the daemon advertises its finalize cap (about 125 s) in retryAfterMs; a finalize that
    // takes 2 s must be noticed on the next poll, not after sleeping the whole cap.
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    repeat(3) {
      fakeDaemonClient.queueExecutePlanResponse(
        buildDaemonResponse(finalizeRefusalPayload("device_cleanup_in_progress", 125_000), true),
      )
    }
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(result.errorMessage, true, result.success)
    assertEquals(listOf(500L, 1000L, 2000L), waits)
    assertEquals(4, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a finalize refusal that never clears is polled until the 150 s cap then given up`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(finalizeRefusalPayload("device_cleanup_in_progress", 125_000), true),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(150_000L, waits.sum())
    assertEquals(4_000L, waits.max())
  }

  @Test
  fun `the finalize wait ends when the daemon finishes and is bounded for the finalize codes only`() {
    val cases =
      listOf(
        // code, ms at which the daemon finishes finalizing (null = no hint), expected total wait
        Triple("device_cleanup_in_progress", null, 30_000L),
        Triple("device_cleanup_in_progress", 1_000L, 1_500L),
        Triple("device_cleanup_in_progress", 125_000L, 125_000L),
        Triple("device_cleanup_in_progress", 600_000L, 150_000L),
        Triple("device_shutting_down", null, 30_000L),
        Triple("device_shutting_down", 1_000L, 1_500L),
        Triple("device_shutting_down", 125_000L, 125_000L),
        Triple("device_shutting_down", 600_000L, 150_000L),
        // Other codes never extend the budget, whatever the hint says.
        Triple("device_owned_by_other_session", 125_000L, 30_000L),
        Triple("device_owned_by_other_daemon", 125_000L, 30_000L),
        Triple("capacity_exhausted", 125_000L, 30_000L),
        Triple("discovery_incomplete", 125_000L, 30_000L),
      )
    for ((code, finalizeAtMs, total) in cases) {
      val finalizes = code == "device_cleanup_in_progress" || code == "device_shutting_down"
      var waited = 0L
      var waits = 0
      while (!(finalizes && finalizeAtMs != null && waited >= finalizeAtMs)) {
        // For the finalize codes the daemon's retryAfterMs is the finalize time still remaining.
        val hint = if (finalizes) finalizeAtMs?.let { it - waited } else finalizeAtMs
        val step = DeviceWaitPolicy.deviceOwnedBackoffDelayMs(waits, waited, hint, code) ?: break
        waited += step
        waits += 1
      }
      assertEquals("$code/$finalizeAtMs total", total, waited)
    }
  }

  @Test
  fun `a finalize refusal reporting time left is never given up on past the 30 s budget`() {
    // The daemon's hint is the REMAINING finalize time, so after 100 s of waiting a 5 s hint must
    // still be honoured rather than judged against a stale total.
    assertEquals(
      4_000L,
      DeviceWaitPolicy.deviceOwnedBackoffDelayMs(
        8,
        100_000L,
        5_000L,
        "device_cleanup_in_progress",
      ),
    )
    assertEquals(
      1_000L,
      DeviceWaitPolicy.deviceOwnedBackoffDelayMs(
        8,
        100_000L,
        1_000L,
        "device_cleanup_in_progress",
      ),
    )
    assertEquals(
      2_000L,
      DeviceWaitPolicy.deviceOwnedBackoffDelayMs(
        8,
        148_000L,
        30_000L,
        "device_shutting_down",
      ),
    )
    assertNull(
      DeviceWaitPolicy.deviceOwnedBackoffDelayMs(
        8,
        150_000L,
        30_000L,
        "device_shutting_down",
      ),
    )
  }

  @Test
  fun `a failed frame is retried only when its typed retryable flag says so`() {
    timings = timings.copy(retryBackoffMs = 0L)
    // code, retryable (null = the frame omits it), message, executePlan calls with maxRetries = 1
    val cases =
      listOf(
        // A frame without the flag keeps the message-based retry (older daemons).
        listOf("daemon_queue_timeout", null, "MCP timeout: tapOn exceeded 30000ms", 1),
        listOf("code_without_flag", null, "daemon request timeout", 2),
        listOf("daemon_queue_timeout", true, "MCP timeout: tapOn exceeded 30000ms", 2),
        listOf("daemon_shutting_down", true, "Daemon is shutting down", 2),
        listOf("daemon_restart_pending", true, "Daemon restart is pending", 2),
        listOf("session_recovery_pending", true, "Cannot safely recover session", 2),
        listOf("daemon_session_suspect", true, "Session missed a liveness heartbeat", 2),
        // A terminal code is the daemon's verdict, even when the message looks transient.
        listOf("device_outside_bound_session", false, "request timeout while binding", 1),
        listOf("some_terminal_code", false, "connection reset", 1),
      )
    for (case in cases) {
      val code = case[0] as String
      fakeDaemonClient = FakeDaemonToolClient()
      collaborators = collaborators.copy(daemon = fakeDaemonClient)
      fakeDaemonClient.setResponse(
        "executePlan",
        DaemonResponse(
          id = code,
          type = "mcp_response",
          success = false,
          error = case[2] as String,
          code = JsonPrimitive(code),
          retryable = (case[1] as Boolean?)?.let { JsonPrimitive(it) },
        ),
      )

      val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

      assertEquals(code, false, result.success)
      assertEquals(code, case[3], fakeDaemonClient.executePlanCalls)
    }
  }

  @Test
  fun `a failed frame with no typed fields keeps the transient message retry`() {
    timings = timings.copy(retryBackoffMs = 0L)
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse("untyped", "mcp_response", false, error = "daemon request timeout"),
    )

    executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(2, fakeDaemonClient.executePlanCalls)
  }

  @Test
  fun `a failed frame for a held device is waited out without spending a retry`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.queueExecutePlanResponse(
      DaemonResponse(
        id = "held",
        type = "mcp_response",
        success = false,
        error = "Device is held",
        code = JsonPrimitive("device_owned_by_other_session"),
        retryable = JsonPrimitive(false),
      ),
    )
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(result.errorMessage, true, result.success)
    assertEquals(listOf(500L), waits)
  }

  @Test
  fun `a retryable failed frame from the executePlan opt-in is retried`() {
    timings = timings.copy(retryBackoffMs = 0L)
    fakeDaemonClient.queueToolSelectionResponse(
      DaemonResponse(
        id = "opt-in",
        type = "mcp_response",
        success = false,
        error = "Daemon is shutting down",
        code = JsonPrimitive("daemon_shutting_down"),
        retryable = JsonPrimitive(true),
      ),
    )
    fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(result.errorMessage, true, result.success)
    assertEquals(2, fakeDaemonClient.toolSelectionArguments.size)
  }

  @Test
  fun `a terminal failed frame from the executePlan opt-in is not retried`() {
    timings = timings.copy(retryBackoffMs = 0L)
    fakeDaemonClient.queueToolSelectionResponse(
      DaemonResponse(
        id = "opt-in",
        type = "mcp_response",
        success = false,
        error = "request timeout",
        code = JsonPrimitive("device_outside_bound_session"),
        retryable = JsonPrimitive(false),
      ),
    )
    fakeDaemonClient.setResponse("executePlan", buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(1, fakeDaemonClient.toolSelectionArguments.size)
  }

  @Test
  fun `a cleanup refusal with no retryAfterMs keeps the 30 s budget`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(finalizeRefusalPayload("device_cleanup_in_progress", null), true),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(false, result.success)
    assertEquals(30_000L, waits.sum())
  }

  @Test
  fun `retryable capacity exhaustion waits within the budget honouring retryAfterMs`() {
    val waits = mutableListOf<Long>()
    timings = timings.copy(deviceOwnedSleeper = { waits.add(it) })
    timings = timings.copy(deviceOwnedWaitBudgetMs = 5_000L)
    fakeDaemonClient.queueExecutePlanResponse(
      buildDaemonResponse(capacityPayload("capacity_exhausted", true, 3000), isError = true),
    )
    fakeDaemonClient.queueExecutePlanResponse(
      buildDaemonResponse(capacityPayload("discovery_incomplete", true, 100), isError = true),
    )
    fakeDaemonClient.queueExecutePlanResponse(buildDaemonResponse(successPayload()))

    val result = executePlan(AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false))

    assertEquals(true, result.success)
    assertEquals(listOf(3000L, 1000L), waits)
    assertEquals(3, fakeDaemonClient.executePlanCalls)
  }
}
