package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.LogEventData
import dev.jasonpearson.automobile.protocol.LogEventResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedLogBufferDrainTest {
  /** A socket that can be down, or fail the sends of chosen messages, logging what it delivered. */
  private class FakeSocket {
    var running = true
    var failOn = emptySet<String>()
    var failWith: Exception = IllegalStateException("socket closed")
    val delivered = mutableListOf<String>()

    fun broadcast(response: WebSocketResponse) {
      val message = (response as LogEventResponse).event.message
      if (message in failOn) throw failWith
      delivered += message
    }
  }

  private val buffer = BoundedLogBuffer(capacity = 8, stats = CtrlProxyWorkStats())
  private val socket = FakeSocket()
  private val failures = mutableListOf<String?>()

  private fun log(message: String) =
    LogEventResponse(
      timestamp = 1L,
      event = LogEventData(level = 3, tag = "App", message = message, pid = 1, tid = 1),
    )

  private fun enqueue(vararg messages: String) {
    messages.forEach { buffer.offer(log(it)) }
    buffer.channel.close()
  }

  private suspend fun drain() =
    buffer.drainTo(
      isRunning = { socket.running },
      broadcast = socket::broadcast,
      onFailure = { failures += it.message },
    )

  @Test
  fun `queued events are broadcast in order until the buffer closes`() = runTest {
    enqueue("a", "b", "c")

    drain()

    assertEquals(listOf("a", "b", "c"), socket.delivered)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `events taken while the server is down are dropped`() = runTest {
    socket.running = false
    enqueue("a", "b")

    drain()

    assertTrue(socket.delivered.isEmpty() && failures.isEmpty())
  }

  @Test
  fun `a failure streak is reported once and a success re-arms the report`() = runTest {
    socket.failOn = setOf("a", "b", "c", "e")
    enqueue("a", "b", "c", "d", "e")

    drain()

    assertEquals(listOf("d"), socket.delivered)
    assertEquals(listOf<String?>("socket closed", "socket closed"), failures)
  }

  @Test(expected = CancellationException::class)
  fun `cancellation is rethrown instead of reported`() = runTest {
    socket.failOn = setOf("a")
    socket.failWith = CancellationException("scope closed")
    enqueue("a")

    try {
      drain()
    } finally {
      assertTrue(failures.isEmpty())
    }
  }
}
