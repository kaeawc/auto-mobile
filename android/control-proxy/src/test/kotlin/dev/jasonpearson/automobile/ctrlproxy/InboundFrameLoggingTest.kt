package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import io.ktor.websocket.Frame
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
internal class InboundFrameLoggingTest : WebSocketServerTestFixtures() {
  @Test
  fun `disabled debug does not build an inbound log line`() =
    runTest(testScope.testScheduler) {
      val connection = server.registerClient(7, RecordingTransport())
      ShadowLog.clear()
      ShadowLog.setLoggable("WebSocketServer", Log.INFO)

      server.handleInboundTextFrame(7, Frame.Text("not JSON"), connection)

      val inboundLines =
        ShadowLog.getLogsForTag("WebSocketServer").filter {
          it.msg.startsWith("Received from client") ||
            it.msg.startsWith("Could not extract request ID")
        }
      assertEquals(emptyList<ShadowLog.LogItem>(), inboundLines)
    }

  @Test
  fun `enabled debug builds one inbound log line`() =
    runTest(testScope.testScheduler) {
      val connection = server.registerClient(7, RecordingTransport())
      ShadowLog.clear()
      ShadowLog.setLoggable("WebSocketServer", Log.DEBUG)
      val raw = """{"type":"tap_on","requestId":"r","text":"private"}"""

      server.handleInboundTextFrame(7, Frame.Text(raw), connection)

      assertEquals(
        listOf("Received from client #7: type=tap_on length=${raw.length}"),
        ShadowLog.getLogsForTag("WebSocketServer")
          .filter { it.msg.startsWith("Received from client") }
          .map { it.msg },
      )
    }

  @Test
  fun `inbound log line preserves type and character length`() {
    val frames =
      listOf(
        """{"type":"tap_on","x":1}""" to "tap_on",
        """{"nested":{"type":"wrong","value":"a\"b"},"type":"request_commit_text","text":"🔒"}""" to
          "request_commit_text",
        """{"type":"tap\u005fon","requestId":"r"}""" to "tap_on",
        """{"type":"put_prototype_asset","requestId":"asset","data":"${"A".repeat(1_000_000)}"}""" to
          "put_prototype_asset",
        """{"type":"bad type"}""" to "unknown",
        """{"type":123}""" to "unknown",
        """{"nested":{"type":"tap_on"}}""" to "unknown",
        """{"type":"tap_on","requestId":"r","data":}""" to "unknown",
        """{"type":"tap_on","requestId":"r"} trailing""" to "unknown",
        """{"type":"tap_on","requestId":"r",""" to "unknown",
        "{" to "unknown",
        "not JSON" to "unknown",
        "" to "unknown",
        "\u0000\u0001\uFFFD" to "unknown",
      )
    frames.forEach { (raw, type) ->
      assertEquals(
        "Received from client #7: type=$type length=${raw.length}",
        WebSocketServer.inboundFrameLogLine(7, raw),
      )
    }
  }
}
