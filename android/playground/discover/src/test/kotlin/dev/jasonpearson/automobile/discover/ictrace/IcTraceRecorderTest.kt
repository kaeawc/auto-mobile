package dev.jasonpearson.automobile.discover.ictrace

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IcTraceRecorderTest {
  private fun record(recorder: IcTraceRecorder, args: String = "") {
    recorder.record("commitText", args, 0, 1, -1, -1)
  }

  @Test
  fun `default clock uses Android monotonic time source`() {
    // The Android SDK stub cannot execute elapsedRealtime in a plain JVM test.
    val recorderClass = IcTraceRecorder::class.java.getResourceAsStream("IcTraceRecorder.class")!!
    val bytecode = recorderClass.use { String(it.readBytes(), StandardCharsets.ISO_8859_1) }
    assertTrue(bytecode.contains("android/os/SystemClock"))
    assertTrue(bytecode.contains("elapsedRealtime"))
  }

  @Test
  fun `captured text is bounded and reports original length`() {
    val recorder = IcTraceRecorder(captureText = true, nowMs = { 0L })
    val text = "x".repeat(20_000)
    val captured = recorder.textArg(text)
    assertTrue(captured.length < 5_000)
    assertTrue(captured.startsWith("\"x"))
    assertTrue(captured.contains("truncated"))
    assertTrue(captured.contains("length=20000"))
    assertEquals("\"short\"", recorder.textArg("short"))
    val nearCap = "x".repeat(4094)
    assertEquals("\"$nearCap\"", recorder.textArg(nearCap))
    assertTrue(recorder.textArg("\u0001".repeat(20_000)).length <= 4096)
    recorder.setCaptureText(false)
    assertEquals("length=20000", recorder.textArg(text))
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

  @Test
  fun `records result metadata and dropped event count`() {
    val recorder = IcTraceRecorder(nowMs = { 0L })
    recorder.updateMetadata(
      IcTraceMetadata(
        scenario = "mid-word replacement",
        keyboardId = "com.example.ime/.KeyboardService",
        keyboardVersion = "2.4",
        inputType = 1,
        imeOptions = 6,
      ),
    )
    repeat(501) { index ->
      recorder.record("setSelection", "start=$index", 0, 0, -1, -1, result = index % 2 == 0)
    }

    assertEquals(1, recorder.droppedEventCount())
    assertEquals(1, recorder.snapshot().last().droppedEvents)
    assertEquals(true, recorder.snapshot().last().result)
    assertEquals("mid-word replacement", recorder.snapshot().last().metadata.scenario)
    assertEquals("2.4", recorder.snapshot().last().metadata.keyboardVersion)

    recorder.updateMetadata(IcTraceMetadata(keyboardId = "com.example.next/.Ime"))
    recorder.record("setSelection", "", 0, 0, -1, -1)
    assertEquals("mid-word replacement", recorder.snapshot().last().metadata.scenario)
  }

  @Test
  fun `redacted read values preserve length without text`() {
    val recorder = IcTraceRecorder(captureText = false, nowMs = { 0L })
    assertEquals("length=8", recorder.safeText("password"))
    assertFalse(recorder.safeText("password")!!.contains("password"))
    assertEquals(null, recorder.safeText(null))
  }
}
