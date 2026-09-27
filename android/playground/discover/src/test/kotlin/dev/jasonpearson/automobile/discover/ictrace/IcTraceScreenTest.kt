package dev.jasonpearson.automobile.discover.ictrace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IcTraceScreenTest {
  @Test
  fun `export delivers captured text only to share callback`() {
    val recorder = IcTraceRecorder(captureText = true, nowMs = { 0L })
    recorder.record("commitText", "text=${recorder.textArg("private")}", 0, 0, -1, -1)
    val shared = mutableListOf<String>()

    exportIcTrace(recorder) { shared += it }

    assertEquals(1, shared.size)
    assertTrue(shared.single().contains("private"))
  }
}
