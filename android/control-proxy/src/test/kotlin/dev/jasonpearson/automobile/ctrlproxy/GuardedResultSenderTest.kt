package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ActionResult
import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The steps [GuardedResultSender] owns for every result (#11877), Android-free. */
class GuardedResultSenderTest {
  private class Transport : FakeResultTransport() {
    var perf: JsonElement? = JsonPrimitive("perf")
    var flushes = 0
    var connectionCountReads = 0
    var failure: Exception? = null

    override fun flushPerfTiming(): JsonElement? {
      flushes++
      return perf
    }

    override suspend fun sendFrame(frame: String) {
      failure?.let { throw it }
      super.sendFrame(frame)
    }

    override fun connectionCount(): Int {
      connectionCountReads++
      return 1
    }
  }

  private val transport = Transport()
  private val errors = mutableListOf<ErrorResponse>()
  private val sender =
    GuardedResultSender(
      transport,
      ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
      logDebug = {},
    )

  @Test
  fun `a stopped server skips the result without building or flushing it`() = runTest {
    transport.running = false
    var built = false

    sender.sendFrame("r1", "swipe_result") {
      built = true
      "frame"
    }

    assertTrue(transport.sentFrames.isEmpty())
    assertEquals(false, built)
    assertEquals(0, transport.flushes)
    assertEquals(0, transport.connectionCountReads)
    assertTrue(errors.isEmpty())
  }

  @Test
  fun `the frame builder receives the flushed perf timing`() = runTest {
    sender.sendFrame("r1", "swipe_result") { perfTiming -> "frame:$perfTiming" }

    assertEquals(listOf("frame:\"perf\""), transport.sentFrames)
    assertEquals(1, transport.flushes)
  }

  @Test
  fun `a result without perf timing leaves the accumulated timing unflushed`() = runTest {
    sender.sendFrame("r1", "preferences", attachPerf = false) { perfTiming ->
      "frame:$perfTiming"
    }

    assertEquals(listOf("frame:null"), transport.sentFrames)
    assertEquals(0, transport.flushes)
  }

  @Test
  fun `a typed result receives the perf timing as compact JSON text`() = runTest {
    sender.send("r1", "action_result") { perfTiming ->
      ActionResult(
        timestamp = 1L,
        requestId = "r1",
        success = true,
        action = "tap",
        totalTimeMs = 2L,
        perfTiming = perfTiming,
      )
    }

    assertEquals("\"perf\"", (transport.sentResponses.single() as ActionResult).perfTiming)
  }

  @Test
  fun `a throw while building becomes an error correlated by the request id`() = runTest {
    sender.sendFrame("r1", "swipe_result") { error("encode failed") }

    assertTrue(transport.sentFrames.isEmpty())
    assertEquals("r1", errors.single().requestId)
    assertEquals("Broadcast failed for swipe_result: encode failed", errors.single().error)
  }

  @Test
  fun `a throw while sending becomes an error correlated by the request id`() = runTest {
    transport.failure = IllegalStateException("socket closed")

    sender.sendFrame("r2", "drag_result") { "frame" }

    assertEquals("r2", errors.single().requestId)
    assertEquals("Broadcast failed for drag_result: socket closed", errors.single().error)
  }

  @Test
  fun `a null request id still sends and reports failures uncorrelated`() = runTest {
    transport.failure = IllegalStateException("gone")

    sender.sendFrame(null, "tap_coordinates_result") { "frame" }

    assertNull(errors.single().requestId)
  }
}
