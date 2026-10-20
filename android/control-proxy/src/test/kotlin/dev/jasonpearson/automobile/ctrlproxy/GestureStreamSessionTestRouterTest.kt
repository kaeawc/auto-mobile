package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Queued router acknowledgements, terminal failure retention, and close. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class GestureStreamSessionTestRouterTest : GestureStreamSessionTestFixtures() {

  @Test
  fun `router forwards the start display through queued continuations`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0, 7))
    h.drain()
    h.router.move("move", "g", 3f, 4f)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()
    h.router.end(RequestGestureEnd("end", "g", 5.0, 6.0, false))
    h.drain()
    dispatcher.completeLast()
    dispatcher.completeLast()
    assertEquals(listOf(7, 7, 7), dispatcher.displays)
    assertEquals(Ack("end", true, null), h.acks.last())
  }

  @Test
  fun `end queued before a failure gets the actual result exactly once`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.drain()
    assertEquals(listOf(Ack("start", true, null)), h.acks)

    // The end was received on IO, but its routing work has not run yet. The gesture callback
    // releases and finishes first on the gesture thread; the queued end must consume that result.
    h.router.end(RequestGestureEnd("end", "g1", 3.0, 4.0, cancel = false))
    h.dispatchers.single().failLast("dispatch cancelled")
    assertEquals(1, h.acks.size)
    h.dispatchers.single().completeLast() // release -> terminal result before the queued end
    h.drain()

    assertEquals(
      listOf(Ack("end", false, "dispatch cancelled")),
      h.acks.filter { it.requestId == "end" },
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `end strictly after a finished session receives its failure`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.drain()
    h.dispatchers.single().failLast("framework cancelled")
    h.dispatchers.single().completeLast() // release -> terminal failure retained for a late end
    h.router.end(RequestGestureEnd("end", "g1", 3.0, 4.0, cancel = false))
    h.router.end(RequestGestureEnd("late-end", "g1", 3.0, 4.0, cancel = false))
    h.drain()

    assertEquals(
      listOf(
        Ack("start", true, null),
        Ack("end", false, "framework cancelled"),
        Ack("late-end", true, null),
      ),
      h.acks,
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `unclaimed failures evict the oldest after sixteen entries`() {
    val h = RouterHarness()
    repeat(17) { index ->
      h.router.start(RequestGestureStart("start-$index", "g$index", 1.0, 2.0))
      h.drain()
      h.dispatchers.last().failLast("failure $index")
      h.dispatchers.last().completeLast() // release -> retain the unclaimed terminal failure
    }
    assertEquals(16, h.terminalFailureCount())

    h.router.end(RequestGestureEnd("evicted", "g0", 3.0, 4.0, cancel = false))
    h.router.end(RequestGestureEnd("recent", "g16", 3.0, 4.0, cancel = false))
    h.drain()

    assertEquals(Ack("evicted", true, null), h.acks.last { it.requestId == "evicted" })
    assertEquals(Ack("recent", false, "failure 16"), h.acks.last { it.requestId == "recent" })
    assertEquals(15, h.terminalFailureCount())
  }

  @Test
  fun `end registered before a failure receives one correlated failure`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.drain()
    h.router.end(RequestGestureEnd("end", "g1", 3.0, 4.0, cancel = false))
    h.drain()
    assertEquals(1, h.pendingEndCount())

    h.dispatchers.single().failLast("lift cancelled")

    assertEquals(listOf(Ack("start", true, null)), h.acks)
    assertEquals(1, h.pendingEndCount())
    h.dispatchers.single().completeLast() // release -> notify the registered end
    assertEquals(listOf(Ack("start", true, null), Ack("end", false, "lift cancelled")), h.acks)
    assertEquals(0, h.pendingEndCount())
  }

  @Test
  fun `queued start and ends give each waiter one result and leave no pending ids`() {
    val h = RouterHarness()
    // Simulate WebSocket calls from two producers before the gesture thread drains its queue.
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.router.start(RequestGestureStart("duplicate", "g1", 1.0, 2.0))
    h.router.end(RequestGestureEnd("end-1", "g1", 3.0, 4.0, cancel = false))
    h.router.end(RequestGestureEnd("end-2", "g1", 3.0, 4.0, cancel = false))
    h.drain()
    assertEquals(2, h.pendingEndCount())

    h.dispatchers.single().completeLast() // initial press -> lift
    h.dispatchers.single().completeLast() // lift -> terminal callback

    assertEquals(
      listOf(
        Ack("start", true, null),
        Ack("duplicate", false, "Gesture g1 is already active"),
        Ack("end-1", true, null),
        Ack("end-2", true, null),
      ),
      h.acks,
    )
    assertEquals(1, h.dispatchers.size)
    assertEquals(0, h.pendingEndCount())

    // Reusing the id must not replay an old end request.
    h.router.start(RequestGestureStart("next", "g1", 5.0, 6.0))
    h.drain()
    h.dispatchers.last().failLast("second gesture failed")
    h.dispatchers.last().completeLast() // release -> fail only the new gesture
    assertEquals(1, h.acks.count { it.requestId == "end-1" })
    assertEquals(1, h.acks.count { it.requestId == "end-2" })
  }

  @Test
  fun `close lifts every active stroke before its callback and clears state`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.router.start(RequestGestureStart("other-start", "g2", 5.0, 6.0))
    h.drain()
    h.router.end(RequestGestureEnd("end", "g1", 3.0, 4.0, cancel = false))
    h.drain()
    assertEquals(1, h.pendingEndCount())

    // Retain an unrelated terminal failure to verify teardown removes it.
    h.router.start(RequestGestureStart("failed-start", "failed", 1.0, 2.0))
    h.drain()
    h.dispatchers.last().failLast("dispatch refused")
    h.dispatchers.last().completeLast() // release -> retain the unrelated terminal failure
    assertEquals(1, h.terminalFailureCount())

    var cancelledBeforeClosed = false
    h.router.close {
      cancelledBeforeClosed =
        h.dispatchers.take(2).all { dispatcher ->
          dispatcher.dispatched.last().let { !it.willContinue && it.from == it.to }
        }
    }
    h.drain()
    assertTrue(cancelledBeforeClosed)
    assertEquals(2, h.dispatchers[0].dispatched.size)
    assertEquals(2, h.dispatchers[1].dispatched.size)
    assertEquals(
      listOf(Ack("end", false, "Gesture stream closed")),
      h.acks.filter { it.requestId == "end" },
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `close answers each pending end once and ignores later requests`() {
    val h = RouterHarness()
    h.router.start(RequestGestureStart("start", "g1", 1.0, 2.0))
    h.router.end(RequestGestureEnd("end-1", "g1", 3.0, 4.0, cancel = false))
    h.router.end(RequestGestureEnd("end-2", "g1", 3.0, 4.0, cancel = false))
    h.drain()

    var closeCount = 0
    h.router.close { closeCount++ }
    h.drain()
    h.dispatchers.single().completeLast() // late lift callback cannot ack either end again
    h.router.close { closeCount++ }
    h.router.start(RequestGestureStart("late-start", "g2", 1.0, 2.0))
    h.router.move("late-move", "g1", 2f, 3f)
    h.router.end(RequestGestureEnd("late-end", "g1", 2.0, 3.0, cancel = true))
    h.drain()

    assertEquals(2, closeCount)
    assertEquals(1, h.acks.count { it.requestId == "end-1" })
    assertEquals(1, h.acks.count { it.requestId == "end-2" })
    assertEquals(false, h.acks.last { it.requestId == "end-1" }.success)
    assertEquals(false, h.acks.last { it.requestId == "end-2" }.success)
    assertEquals(1, h.dispatchers.size)
    assertFalse(h.acks.any { it.requestId?.startsWith("late-") == true })
  }

  @Test
  fun `rejected close post still invokes its callback`() {
    val h = RouterHarness()
    h.router.close()
    h.drain()
    h.acceptPosts = false
    var closeCount = 0

    h.router.close { closeCount++ }

    assertEquals(1, closeCount)
  }
}
