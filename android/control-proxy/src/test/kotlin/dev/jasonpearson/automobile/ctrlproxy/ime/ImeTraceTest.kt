package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Test

class ImeTraceTest {
  @Test
  fun `ordered lines omit nulls sanitize tokens and mirror emission`() {
    val emitted = mutableListOf<String>()
    val recorder = ImeTraceRecorder(elapsedRealtimeMs = { 42L }, emit = emitted::add)
    recorder.record("start", "gen" to 2L, "missing" to null, "active" to true, "pkg" to "dev.app")
    recorder.record(
      "invalid",
      "space" to "secret text",
      "newline" to "a\nb",
      "long" to "x".repeat(65),
      "unicode" to "é",
      "object" to Any(),
    )
    assertEquals("seq=1 t=42 event=start gen=2 active=true pkg=dev.app", emitted[0])
    assertEquals(
      "seq=2 t=42 event=invalid space=invalid newline=invalid long=invalid unicode=invalid object=invalid",
      emitted[1],
    )
    assertEquals(emitted, recorder.snapshot())
  }

  @Test
  fun `recorder failures cannot escape and snapshots are copies`() {
    val recorder =
      ImeTraceRecorder(capacity = 1, elapsedRealtimeMs = { 0L }, emit = { error("unavailable") })
    recorder.record("first")
    val snapshot = recorder.snapshot()
    recorder.record("second")
    assertEquals(listOf("seq=1 t=0 event=first"), snapshot)
    assertEquals(listOf("seq=2 t=0 event=second"), recorder.snapshot())
    ImeTraceRecorder(elapsedRealtimeMs = { error("clock unavailable") }, emit = {}).record("tick")
  }

  @Test
  fun `ring retains last 256 of 300 without resetting sequence`() {
    val recorder = ImeTraceRecorder(elapsedRealtimeMs = { 0L }, emit = {})
    repeat(300) { recorder.record("tick") }
    assertEquals(256, recorder.snapshot().size)
    assertEquals("seq=45 t=0 event=tick", recorder.snapshot().first())
    assertEquals("seq=300 t=0 event=tick", recorder.snapshot().last())
  }

  @Test
  fun `normal summary includes only metadata and passwords include only secure`() {
    assertEquals(
      listOf(
        "editorPkg" to "dev.app",
        "fieldId" to 7,
        "inputType" to 1,
        "imeOptions" to 6,
        "secure" to false,
      ),
      editorTraceFields("dev.app", 7, 1, 6).toList(),
    )
    val passwords =
      listOf(
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
      )
    for (inputType in passwords) {
      assertEquals(listOf("secure" to true), editorTraceFields("dev.app", 7, inputType, 6).toList())
    }
  }
}
