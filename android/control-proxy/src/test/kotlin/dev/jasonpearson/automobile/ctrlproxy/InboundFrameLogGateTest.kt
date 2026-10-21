package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

internal class InboundFrameLogGateTest {
  @Test
  fun `disabled sink never invokes line builder`() {
    val sink = FakeLogSink(enabled = false)
    var builds = 0

    WebSocketServer.logInboundFrame(sink) {
      builds++
      "line"
    }

    assertEquals(0, builds)
    assertEquals(emptyList<String>(), sink.lines)
  }

  @Test
  fun `enabled sink invokes line builder exactly once`() {
    val sink = FakeLogSink(enabled = true)
    var builds = 0

    WebSocketServer.logInboundFrame(sink) {
      builds++
      "line"
    }

    assertEquals(1, builds)
    assertEquals(listOf("line"), sink.lines)
  }

  private class FakeLogSink(private val enabled: Boolean) : WebSocketServer.InboundLogSink {
    val lines = mutableListOf<String>()

    override fun isDebugEnabled(): Boolean = enabled

    override fun debug(message: String) {
      lines.add(message)
    }
  }
}
