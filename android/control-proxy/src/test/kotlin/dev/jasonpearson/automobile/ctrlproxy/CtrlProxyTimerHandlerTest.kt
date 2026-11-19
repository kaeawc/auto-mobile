package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

internal class CtrlProxyTimerHandlerTest : CtrlProxyMessageHandlerFixtures() {
  @Test
  fun `advance prototype clock dispatches correlated id and duration`() = runTest {
    dispatch(
      """{"type":"advance_prototype_clock","requestId":"advance","id":"panel","advanceTimeMs":250}""",
    )
    assertEquals("advancePrototypeClock", lastCall.first)
    assertEquals(listOf("advance", "panel", 250), lastCall.second)
  }

  @Test
  fun `simulate platform dispatches correlated id event and data`() = runTest {
    dispatch(
      """{"type":"simulate_prototype_platform","requestId":"sim","id":"panel","event":"test.tick","data":{"count":7}}""",
    )
    assertEquals("simulatePrototypePlatform", lastCall.first)
    assertEquals(
      listOf("sim", "panel", "test.tick", buildJsonObject { put("count", 7) }),
      lastCall.second,
    )
  }

  @Test
  fun `queue call outcome dispatches the correlated body`() = runTest {
    dispatch(
      """{"type":"queue_prototype_call_outcome","requestId":"script","id":"panel","call":"test.echo","outcome":{"result":null}}""",
    )
    assertEquals("queuePrototypeCallOutcome", lastCall.first)
    assertEquals(
      listOf("script", "panel", "test.echo", buildJsonObject { put("result", JsonNull) }),
      lastCall.second,
    )
  }
}
