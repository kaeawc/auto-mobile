package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.LogEventResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class LogcatReaderTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun prepareBuffer() {
      BoundedLogBuffer(1, CtrlProxyWorkStats()).channel.close()
    }
  }

  private val sampleLine = "04-01 12:34:56.789  1234  5678 D MyTag: Hello world"

  private class Recorder {
    val events = mutableListOf<WebSocketResponse>()

    fun onLogEvent(response: WebSocketResponse) {
      events.add(response)
    }
  }

  @Test
  fun `with zero connections a delivered line produces no broadcast`() {
    val recorder = Recorder()
    val reader = LogcatReader(onLogEvent = recorder::onLogEvent, hasConsumer = { false })

    reader.handleLine(sampleLine)

    assertTrue("No broadcast expected when no client is connected", recorder.events.isEmpty())
  }

  @Test
  fun `with a connection a delivered line produces a broadcast`() {
    val recorder = Recorder()
    val reader = LogcatReader(onLogEvent = recorder::onLogEvent, hasConsumer = { true })

    reader.handleLine(sampleLine)

    assertEquals(1, recorder.events.size)
  }

  @Test
  fun `connection state is evaluated per line`() {
    val recorder = Recorder()
    var connected = false
    val reader = LogcatReader(onLogEvent = recorder::onLogEvent, hasConsumer = { connected })

    reader.handleLine(sampleLine)
    assertTrue(recorder.events.isEmpty())

    connected = true
    reader.handleLine(sampleLine)
    assertEquals(1, recorder.events.size)

    connected = false
    reader.handleLine(sampleLine)
    assertEquals(1, recorder.events.size)
  }

  @Test
  fun `parseLine parses a valid threadtime line`() {
    val reader = LogcatReader(onLogEvent = {})

    val response = reader.parseLine(sampleLine)

    assertNotNull(response)
  }

  @Test
  fun `parseLine prefilter rejects non-entry lines without regex`() {
    val reader = LogcatReader(onLogEvent = {})

    assertNull(reader.parseLine("--------- beginning of main"))
    assertNull(reader.parseLine(""))
    assertNull(reader.parseLine("not a log line"))
  }

  @Test
  fun `own diagnostics are filtered while warnings and application logs pass`() {
    val delivered = mutableListOf<WebSocketResponse>()
    val stats = CtrlProxyWorkStats()
    val reader =
      LogcatReader(
        onLogEvent = { delivered.add(it) },
        ownPid = { 1234 },
        stats = stats,
      )

    reader.handleLine("04-01 12:34:56.789  1234  5678 D ViewHierarchyExtractor: [OPT] -> KEEP")
    reader.handleLine("04-01 12:34:56.789  1234  5678 V CtrlProxy: diagnostic")
    reader.handleLine("04-01 12:34:56.789  1234  5678 W CtrlProxy: important warning")
    reader.handleLine("04-01 12:34:56.789  4321  5678 D MyApp: requested app log")

    assertEquals(2L, stats.droppedInternalLogLines.get())
    assertEquals(2L, stats.forwardedLogLines.get())
    assertEquals(2, delivered.size)
    assertEquals("important warning", (delivered[0] as LogEventResponse).event.message)
    assertEquals("requested app log", (delivered[1] as LogEventResponse).event.message)
  }

  @Test
  fun `delivery rejects overflow without growing the buffer`() {
    val stats = CtrlProxyWorkStats()
    val buffer = BoundedLogBuffer(capacity = 2, stats = stats)
    val reader =
      LogcatReader(
        onLogEvent = {},
        tryDeliver = buffer::offer,
        ownPid = { 1234 },
        stats = stats,
      )

    repeat(20) { reader.handleLine("04-01 12:34:56.789  4321  5678 D MyApp: log $it") }

    assertEquals(
      "log 0",
      (buffer.channel.tryReceive().getOrNull() as LogEventResponse).event.message,
    )
    assertEquals(
      "log 1",
      (buffer.channel.tryReceive().getOrNull() as LogEventResponse).event.message,
    )
    assertNull(buffer.channel.tryReceive().getOrNull())
    assertEquals(2L, stats.forwardedLogLines.get())
    assertEquals(18L, stats.droppedOverflowLogLines.get())
  }

  @Test
  fun `warning displaces an older log when delivery is saturated`() {
    val stats = CtrlProxyWorkStats()
    val buffer = BoundedLogBuffer(capacity = 1, stats = stats)
    val reader =
      LogcatReader(
        onLogEvent = {},
        tryDeliver = buffer::offer,
        ownPid = { 1234 },
        stats = stats,
      )
    reader.handleLine("04-01 12:34:56.789  4321  5678 D MyApp: old")
    reader.handleLine("04-01 12:34:56.789  1234  5678 W CtrlProxy: warning")

    assertEquals(
      "warning",
      (buffer.channel.tryReceive().getOrNull() as LogEventResponse).event.message,
    )
    assertEquals(1L, stats.droppedOverflowLogLines.get())
    assertEquals(2L, stats.forwardedLogLines.get())
  }
}
