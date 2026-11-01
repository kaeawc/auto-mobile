package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HierarchyExtractFrameSenderTest {
  /** A WebSocket server that can be down or fail, logging how each frame was routed. */
  private class FakeTransport : HierarchyExtractFrameSender.Transport {
    var running = true
    var failWith: RuntimeException? = null
    val sent = mutableListOf<String>()

    override fun isRunning() = running

    override suspend fun broadcastExternallyCorrelated(frame: ErrorResponse) {
      failWith?.let { throw it }
      sent += "external:${frame.requestId}"
    }

    override suspend fun broadcast(frame: ErrorResponse) {
      failWith?.let { throw it }
      sent += "broadcast:${frame.requestId}"
    }
  }

  private val transport = FakeTransport()
  private val guardErrors = mutableListOf<String?>()
  private val sender =
    HierarchyExtractFrameSender(
      transport,
      ResultBroadcaster(broadcastError = { guardErrors += it.requestId }, logError = { _, _ -> }),
    )

  private fun frame(uuid: String) = HierarchyExtractErrorFrames.nullResultFrame(uuid)

  @Test
  fun `a broadcast-correlated frame is routed as externally correlated by default`() = runTest {
    sender.send(frame("sync_1"))

    assertEquals(listOf("external:sync_1"), transport.sent)
  }

  @Test
  fun `a socket-correlated frame uses the ordinary broadcast`() = runTest {
    sender.send(frame("req_2"), externallyCorrelated = false)

    assertEquals(listOf("broadcast:req_2"), transport.sent)
  }

  @Test
  fun `nothing is sent for a null frame or while the server is down`() = runTest {
    sender.send(null)
    transport.running = false
    sender.send(frame("sync_3"))

    assertTrue(transport.sent.isEmpty() && guardErrors.isEmpty())
  }

  @Test
  fun `a failed send is contained by the guard instead of escaping`() = runTest {
    transport.failWith = IllegalStateException("socket closed")

    sender.send(frame("sync_4"))

    assertEquals(listOf<String?>("sync_4"), guardErrors)
  }
}
