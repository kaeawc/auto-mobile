package dev.jasonpearson.automobile.ctrlproxy

import io.ktor.websocket.CloseReason
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Outbound deadlines, queue pressure, coalescing, and per-client ordering. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerTestOutboundTest : WebSocketServerTestFixtures() {

  @Test
  fun `stalled outbound send disconnects exactly at its deadline`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options = WebSocketServerOptions(sendTimeoutMs = timeoutMs),
        )
      val stalled = StalledTransport()
      server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()

      advanceTimeBy(timeoutMs - 1)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertNull(stalled.closeReason)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(0, server.getConnectionCount())
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertEquals("Outbound send timed out", stalled.closeReason?.message)
      assertTrue(stalled.messages.isEmpty())
    }

  @Test
  fun `completed outbound sends stay connected beyond the deadline`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options = WebSocketServerOptions(sendTimeoutMs = timeoutMs),
        )
      val healthy = RecordingTransport()
      server.registerClient(1, healthy)
      val messages = listOf("first", "second", "third")
      messages.forEach { server.broadcast(it) }
      runCurrent()

      advanceTimeBy(timeoutMs * 10)
      runCurrent()
      assertEquals(messages, healthy.messages)
      assertEquals(1, server.getConnectionCount())
      server.broadcast("after-deadline")
      runCurrent()
      assertEquals(messages + "after-deadline", healthy.messages)
    }

  @Test
  fun `outbound send cancellation propagates without timeout cleanup`() =
    runTest(testScope.testScheduler) {
      val cancelled = StalledTransport()
      val cancellation = CancellationException("Transport cancelled")
      val client =
        server.registerClient(
          1,
          object : WebSocketServer.ClientTransport by cancelled {
            override suspend fun send(message: String) {
              throw cancellation
            }
          },
        )
      var completionCause: Throwable? = null
      client.sender.invokeOnCompletion { completionCause = it }
      server.broadcast("cancelled")
      runCurrent()

      assertTrue(client.sender.isCancelled)
      assertTrue(completionCause is CancellationException)
      assertEquals(cancellation.message, completionCause?.message)
      assertEquals(1, server.getConnectionCount())
      assertNull(cancelled.closeReason)
    }

  @Test
  fun `outbound timeout disconnects only the stalled client`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options = WebSocketServerOptions(sendTimeoutMs = timeoutMs),
        )
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      server.registerClient(1, stalled)
      val healthyClient = server.registerClient(2, healthy)
      server.broadcast("shared")
      runCurrent()

      advanceTimeBy(timeoutMs + 1)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertEquals(listOf("shared"), healthy.messages)
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertFalse(healthyClient.sender.isCancelled)
    }

  @Test
  fun `frames after outbound timeout complete without advancing time`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options = WebSocketServerOptions(sendTimeoutMs = timeoutMs),
        )
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      val stalledClient = server.registerClient(1, stalled)
      server.registerClient(2, healthy)
      server.broadcast("in-flight")
      runCurrent()
      server.sendToClient(stalledClient, "pending")
      advanceTimeBy(timeoutMs)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertEquals(0, stalledClient.pendingCount)

      val timeAfterTimeout = testScheduler.currentTime
      val broadcasting = launch {
        server.broadcast("after-timeout")
        server.sendToClient(stalledClient, "removed-client")
      }
      runCurrent()
      assertTrue(broadcasting.isCompleted)
      assertFalse(broadcasting.isCancelled)
      assertEquals(timeAfterTimeout, testScheduler.currentTime)
      assertEquals(listOf("in-flight", "after-timeout"), healthy.messages)
      stalled.unblock()
      runCurrent()
      assertTrue(stalled.messages.isEmpty())
      assertTrue(stalledClient.sender.isCompleted)
    }

  @Test
  fun `outbound timeout clears only the stalled clients request owners`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options = WebSocketServerOptions(sendTimeoutMs = timeoutMs),
        )
      val owner = server.registerClient(1, StalledTransport())
      val healthyOwner = server.registerClient(2, RecordingTransport())
      server.registerRequestOwner("stalled-request", owner)
      server.registerRequestOwner("healthy-request", healthyOwner)
      server.sendToClient(owner, "in-flight")
      runCurrent()
      assertTrue(server.hasRequestOwner("stalled-request"))

      advanceTimeBy(timeoutMs)
      runCurrent()
      assertFalse(server.hasRequestOwner("stalled-request"))
      assertTrue(server.hasRequestOwner("healthy-request"))
      assertEquals(1, server.getConnectionCount())
    }

  @Test
  fun `droppable burst sheds frames and preserves correlated response after a brief stall`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()

      repeat(WebSocketServer.OUTGOING_CAPACITY + 80) { index ->
        val type = if (index % 2 == 0) "log_event" else "network_event"
        server.broadcast("""{"type":"$type","index":$index}""")
      }
      val response = """{"type":"action_result","requestId":"awaited"}"""
      server.sendToClient(client, response)

      assertEquals(1, server.getConnectionCount())
      assertNull(stalled.closeReason)
      assertTrue(client.droppedCount > 0)
      assertEquals(WebSocketServer.OUTGOING_CAPACITY, client.pendingCount)
      stalled.unblock()
      runCurrent()
      assertEquals("in-flight", stalled.messages.first())
      assertFalse(stalled.messages.contains("""{"type":"log_event","index":0}"""))
      assertTrue(stalled.messages.contains("""{"type":"network_event","index":143}"""))
      assertEquals(response, stalled.messages.last())
    }

  @Test
  fun `correlated response uses reserve behind must deliver frames`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()
      repeat(WebSocketServer.OUTGOING_CAPACITY) {
        server.broadcast("""{"type":"must_deliver","index":$it}""")
      }
      val response = """{"type":"action_result","requestId":"awaited"}"""
      server.sendToClient(client, response)

      assertEquals(WebSocketServer.OUTGOING_CAPACITY + 1, client.pendingCount)
      assertEquals(1, server.getConnectionCount())
      stalled.unblock()
      runCurrent()
      assertEquals(response, stalled.messages.last())
    }

  @Test
  fun `pending hierarchy updates coalesce in place`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()
      val first = """{"type":"hierarchy_update","data":"old"}"""
      val newest = """{"type":"hierarchy_update","data":"new"}"""
      server.broadcast(first)
      server.broadcast("marker")
      server.broadcast(newest)

      assertEquals(1L, client.droppedCount)
      assertEquals(2, client.pendingCount)
      stalled.unblock()
      runCurrent()
      assertEquals(listOf("in-flight", newest, "marker"), stalled.messages)
    }

  @Test
  fun `stalled client is closed at hard ceiling while healthy client receives ordered frames`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      val stalledClient = server.registerClient(1, stalled)
      server.registerClient(2, healthy)
      runCurrent()

      val messages =
        (0..WebSocketServer.OUTGOING_HARD_CEILING + 1).map {
          """{"type":"must_deliver","index":$it}"""
        }
      server.broadcast(messages.first())
      runCurrent() // The stalled sender is now blocked on its first frame.
      messages.drop(1).take(WebSocketServer.OUTGOING_HARD_CEILING).chunked(32).forEach { batch ->
        batch.forEach { server.broadcast(it) }
        runCurrent() // Healthy client drains independently after each short burst.
      }
      // One frame is in flight and exactly the hard ceiling is waiting behind it.
      assertEquals(2, server.getConnectionCount())
      assertNull(stalled.closeReason)

      messages.drop(WebSocketServer.OUTGOING_HARD_CEILING + 1).forEach { server.broadcast(it) }
      runCurrent()

      assertEquals(messages, healthy.messages)
      assertEquals(1, server.getConnectionCount())
      assertTrue(
        stalledClient.outgoing
          .trySend(
            WebSocketServer.OutgoingFrame(
              "after-disconnect",
              WebSocketServer.OutgoingTier.MUST_DELIVER,
            ),
          )
          .isFailure,
      )
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertTrue(stalled.closeReason?.message?.contains("Outgoing buffer full") == true)
    }

  @Test
  fun `sync hierarchy enqueue precedes correlated response for its client`() =
    runTest(testScope.testScheduler) {
      val transport = RecordingTransport()
      val client = server.registerClient(1, transport)
      val hierarchy = """{"type":"hierarchy_update","data":"current"}"""
      val response = """{"type":"action_result","requestId":"awaited"}"""

      server.broadcastWithPerfSync { hierarchy }
      server.sendToClient(client, response)
      runCurrent()

      assertEquals(listOf(hierarchy, response), transport.messages)
    }
}
