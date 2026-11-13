package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A short plan video must reach the test's result, not only the daemon log (#18276). */
internal class PlanVideoWarningsTest : PlanExecutorTestFixture() {
  @Test
  fun `a passing plan carries the daemon's video warnings`() {
    val warning =
      "Video truncated: the recording covers 4.1s of the 30.4s plan run; the recorder ended " +
        "early and the rest of the plan was not recorded."
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload(
          """{"success":true,"executedSteps":2,"totalSteps":2,"platform":"android",
            "deviceId":"emulator-5554","videoFilePaths":["/fake/video.mp4"],
            "videoWarnings":["$warning"]}""",
        ),
      ),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertTrue(result.success)
    assertEquals(listOf(warning), result.videoWarnings)
  }

  @Test
  fun `a complete plan video has no warnings`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      buildDaemonResponse(
        payload(
          """{"success":true,"executedSteps":1,"totalSteps":1,
            "videoFilePaths":["/fake/video.mp4"]}""",
        ),
      ),
    )

    val result = executePlan(AutoMobilePlanExecutionOptions(aiAssistance = false))

    assertTrue(result.success)
    assertEquals(emptyList<String>(), result.videoWarnings)
  }
}
