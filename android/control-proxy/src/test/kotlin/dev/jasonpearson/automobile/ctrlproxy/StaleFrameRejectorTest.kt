package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.GlobalActionResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StaleFrameRejectorTest {
  private class FixedTimer : TimeProvider {
    override fun currentTimeMillis() = 4_242L
  }

  /** Holds each launched rejection until the test runs it, and logs every envelope sent. */
  private class FakeHost : StaleFrameRejector.Host {
    val launched = mutableListOf<Pair<String?, suspend CoroutineScope.() -> Unit>>()
    val sent = mutableListOf<String>()
    var imeAction: ImeActionFrameResult? = null
    var globalAction: GlobalActionResult? = null

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      launched += requestId to block
    }

    override suspend fun broadcastTapCoordinatesResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
    ) {
      sent += "tap:$requestId:$success:$totalTimeMs:$error"
    }

    override suspend fun broadcastSwipeResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
      gestureTimeMs: Long?,
    ) {
      sent += "swipe:$requestId:$success:$totalTimeMs:$gestureTimeMs:$error"
    }

    override suspend fun broadcastDragResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
      gestureTimeMs: Long?,
    ) {
      sent += "drag:$requestId:$success:$totalTimeMs:$gestureTimeMs:$error"
    }

    override suspend fun broadcastSetTextResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
    ) {
      sent += "set_text:$requestId:$success:$totalTimeMs:$error"
    }

    override suspend fun broadcastImeActionResult(outcome: ImeActionFrameResult) {
      sent += "ime_action:${outcome.requestId}"
      imeAction = outcome
    }

    override suspend fun broadcastGlobalActionResult(result: GlobalActionResult) {
      sent += "global_action:${result.requestId}"
      globalAction = result
    }
  }

  private val host = FakeHost()
  private var current = "run-a:3"
  private val rejector =
    StaleFrameRejector(
      isStale = { expected -> expected != null && expected != current },
      host = host,
      timeProvider = FixedTimer(),
    )

  private fun hint(action: String) =
    "Stale frame context for input/$action; observe a fresh frame before retrying"

  private suspend fun CoroutineScope.runLaunched() {
    host.launched.forEach { (_, block) -> block() }
  }

  @Test
  fun `a current or unchecked token lets the input through with nothing sent`() = runTest {
    for (action in StaleFrameContextAction.entries) {
      assertFalse(rejector.rejectStaleFrameContext("req", "run-a:3", action))
      assertFalse(rejector.rejectStaleFrameContext("req", null, action))
    }

    assertTrue(host.launched.isEmpty())
  }

  @Test
  fun `a stale gesture is refused with its own failed result under its request id`() = runTest {
    assertTrue(rejector.rejectStaleFrameContext("t1", "run-a:2", StaleFrameContextAction.TAP))
    assertTrue(rejector.rejectStaleFrameContext("s1", "run-a:2", StaleFrameContextAction.SWIPE))
    assertTrue(rejector.rejectStaleFrameContext("d1", "run-a:2", StaleFrameContextAction.DRAG))
    assertEquals(listOf("t1", "s1", "d1"), host.launched.map { it.first })

    runLaunched()

    assertEquals(
      listOf(
        "tap:t1:false:0:${hint("tap")}",
        "swipe:s1:false:0:null:${hint("swipe")}",
        "drag:d1:false:0:null:${hint("drag")}",
      ),
      host.sent,
    )
  }

  @Test
  fun `a stale text input is refused with its own failed result`() = runTest {
    rejector.rejectStaleFrameContext("x1", "run-b:3", StaleFrameContextAction.SET_TEXT)
    rejector.rejectStaleFrameContext("i1", "run-b:3", StaleFrameContextAction.IME_ACTION)

    runLaunched()

    assertEquals(listOf("set_text:x1:false:0:${hint("set_text")}", "ime_action:i1"), host.sent)
    val ime = host.imeAction!!
    assertEquals("ime_action", ime.action)
    assertFalse(ime.success)
    assertEquals(hint("ime_action"), ime.error)
    assertEquals(0L, ime.totalTimeMs)
  }

  @Test
  fun `a stale global action is refused with a timestamped global action result`() = runTest {
    rejector.rejectStaleFrameContext("g1", "run-a:1", StaleFrameContextAction.GLOBAL_ACTION)

    runLaunched()

    val result = host.globalAction!!
    assertEquals("g1", result.requestId)
    assertFalse(result.success)
    assertEquals("global_action", result.action)
    assertEquals(hint("global_action"), result.error)
    assertEquals(4_242L, result.timestamp)
    assertEquals(0L, result.totalTimeMs)
  }

  @Test
  fun `every action answers a rejection with exactly one envelope`() = runTest {
    StaleFrameContextAction.entries.forEach {
      rejector.rejectStaleFrameContext("r-${it.wireName}", "old", it)
    }

    runLaunched()

    assertEquals(
      StaleFrameContextAction.entries.map { it.wireName },
      host.sent.map {
        it.substringBefore(':')
      },
    )
  }
}
