package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A plan step whose tool succeeded but whose `expectations` did not hold fails `executePlan`
 * (#16817). The envelope is the real TypeScript executor's response, pinned by
 * test/server/executePlanToolResultsCapture.test.ts.
 */
internal class FailedExpectationPlanTest : PlanExecutorTestFixture() {
  @Test
  fun `a failed expectation fails the plan and the message names the expectation and what was observed`() {
    val text =
      checkNotNull(
          javaClass.classLoader.getResource("captured/execute-plan-failed-expectation.json"),
        )
        .readText()
    val envelope = json.parseToJsonElement(text) as JsonObject
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse(id = "captured", type = "mcp_response", success = true, result = envelope),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false, maxRetries = 0))

    assertEquals(false, result.success)
    assertEquals(1, result.exitCode)
    assertTrue(
      result.errorMessage,
      result.errorMessage.contains(
        "Expectation 1/1 (textEquals testTag=\"counter\" text=\"1\") failed: not satisfied after 5000ms",
      ),
    )
    assertTrue(result.errorMessage, result.errorMessage.contains("observed texts: \"Count: 0\""))
  }
}
