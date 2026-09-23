package dev.jasonpearson.automobile.discover.ictrace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IcTraceRecorderTest {
  private fun record(recorder: IcTraceRecorder, args: String = "") {
    recorder.record("commitText", args, 0, 1, -1, -1)
  }

  @Test
  fun `evicts oldest events and keeps monotonic sequence`() {
    var time = 100L
    val recorder = IcTraceRecorder(nowMs = { time })
    repeat(502) {
      time++
      record(recorder)
    }
    val events = recorder.snapshot()
    assertEquals(500, events.size)
    assertEquals((3..502).toList(), events.map { it.seq })
    assertEquals(3L, events.first().elapsedMs)
    assertEquals(events, recorder.events.value)
  }

  @Test
  fun `clear empties events but retains sequence and elapsed baseline`() {
    var time = 10L
    val recorder = IcTraceRecorder(nowMs = { time })
    record(recorder)
    recorder.clear()
    assertTrue(recorder.snapshot().isEmpty())
    assertTrue(recorder.events.value.isEmpty())
    time = 20L
    record(recorder)
    assertEquals(2, recorder.snapshot().single().seq)
    assertEquals(10L, recorder.snapshot().single().elapsedMs)
  }

  @Test
  fun `redacted argument records length without content`() {
    val recorder = IcTraceRecorder(captureText = false, nowMs = { 0L })
    record(recorder, "text=${recorder.textArg("private")}")
    assertEquals("text=length=7", recorder.snapshot().single().args)
    assertFalse(recorder.snapshot().single().args.contains("private"))
  }

  @Test
  fun `snapshot keeps insertion order and is independent of future records`() {
    val recorder = IcTraceRecorder(nowMs = { 0L })
    record(recorder, "first")
    record(recorder, "second")
    val snapshot = recorder.snapshot()
    record(recorder, "third")
    assertEquals(listOf("first", "second"), snapshot.map { it.args })
    assertEquals(listOf("first", "second", "third"), recorder.snapshot().map { it.args })
  }
}
