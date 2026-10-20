package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.TapOnResponse
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class PlanResponseParsingTest : PlanExecutorTestFixture() {
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
    timings = timings.copy(retryBackoffMs = 0L)

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
    timings = timings.copy(retryBackoffMs = 0L)

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
      System.setProperty(PlanRequestOptions.CAPTURE_OBSERVE_STEPS_PROPERTY, input)
      try {
        assertEquals(
          "input=\"$input\"",
          expected,
          PlanRequestOptions.resolveCaptureObserveSteps(),
        )
      } finally {
        System.clearProperty(PlanRequestOptions.CAPTURE_OBSERVE_STEPS_PROPERTY)
      }
    }
  }

  @Test
  fun `resolveCaptureObserveSteps returns null when property is unset`() {
    System.clearProperty(PlanRequestOptions.CAPTURE_OBSERVE_STEPS_PROPERTY)
    // Cannot set env vars from tests; this falls through to the env-var branch which is also unset
    // in the test JVM, so a null result here also covers the "neither set" case.
    assertNull(PlanRequestOptions.resolveCaptureObserveSteps())
  }
}
