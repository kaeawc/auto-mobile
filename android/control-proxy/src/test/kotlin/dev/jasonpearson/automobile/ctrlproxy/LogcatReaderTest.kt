package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.WebSocketResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogcatReaderTest {

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
}
