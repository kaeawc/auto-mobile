package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
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
}
