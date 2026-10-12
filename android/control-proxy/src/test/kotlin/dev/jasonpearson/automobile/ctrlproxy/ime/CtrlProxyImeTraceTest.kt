package dev.jasonpearson.automobile.ctrlproxy.ime

import android.inputmethodservice.InputMethodService
import android.os.Looper
import android.text.InputType
import android.view.inputmethod.EditorInfo
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24])
class CtrlProxyImeTraceTest {
  @Test
  fun `callbacks record generation and editor metadata without descriptive text`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    val info =
      EditorInfo().apply {
        packageName = "dev.app"
        fieldId = 7
        inputType = 1
        imeOptions = 6
        hintText = SECRET
        fieldName = SECRET
        label = SECRET
      }
    service.onBindInput()
    service.onStartInput(info, false)
    service.onStartInput(info, true)
    service.onStartInputView(info, true)
    service.onFinishInputView(true)
    service.onFinishInput()
    service.onUnbindInput()
    val lines = service.traceSnapshot()
    assertEquals(
      listOf(
        "onBindInput",
        "onStartInput",
        "onStartInput",
        "onStartInputView",
        "onFinishInputView",
        "onFinishInput",
        "onUnbindInput",
      ),
      lines.map { it.substringAfter("event=").substringBefore(' ') },
    )
    assertEquals(
      listOf(0, 1, 2, 2, 2, 3, 3),
      lines.map { it.substringAfter("gen=").substringBefore(' ').toInt() },
    )
    assertTrue(lines.all { it.contains("commitActive=false") && !it.contains(SECRET) })
    assertTrue(
      lines[1].endsWith(
        "restarting=false editorPkg=dev.app fieldId=7 inputType=1 imeOptions=6 secure=false",
      ),
    )
    assertTrue(lines[2].contains("restarting=true"))
    assertTrue(lines[4].endsWith("finishingInput=true"))
  }

  @Test
  fun `secure summaries omit all editor metadata and absent info reports none`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    service.onStartInput(
      EditorInfo().apply {
        packageName = SECRET
        fieldId = 7
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        hintText = SECRET
        fieldName = SECRET
        label = SECRET
      },
      false,
    )
    val line = service.traceSnapshot().last()
    assertTrue(line.endsWith("restarting=false secure=true"))
    for (field in listOf("editorPkg", "fieldId", "inputType", "imeOptions", SECRET)) assertFalse(
      line.contains(field),
    )
    service.onStartInput(null, true)
    assertTrue(service.traceSnapshot().last().endsWith("restarting=true editor=none"))
  }

  @Test
  fun `selection is silent when idle and traced during commit with optional snapshot`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    service.onUpdateSelection(0, 0, 1, 1, -1, -1)
    assertTrue(service.traceSnapshot().isEmpty())
    var cancelled = false
    var result: ImeCommitResult? = null
    service.commitText(SECRET, null, isCancelled = { cancelled }, trace = true) { result = it }
    shadowOf(Looper.getMainLooper()).idle()
    service.onUpdateSelection(0, 0, 1, 1, -1, -1)
    val line = service.traceSnapshot().last()
    assertTrue(line.contains("event=onUpdateSelection gen=0 commitActive=true commit=1"))
    assertTrue(
      line.endsWith(
        "oldSelStart=0 oldSelEnd=0 newSelStart=1 newSelEnd=1 candidatesStart=-1 candidatesEnd=-1",
      ),
    )
    cancelled = true
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
    assertEquals(service.traceSnapshot(), requireNotNull(result).trace)
    assertTrue(requireNotNull(result).trace!!.last().contains("event=commitFinish"))
    assertTrue(service.traceSnapshot().all { !it.contains(SECRET) })
    val size = service.traceSnapshot().size
    service.onUpdateSelection(0, 0, 1, 1, -1, -1)
    assertEquals(size, service.traceSnapshot().size)
  }

  @Test
  fun `password selection and commit start omit positions and text length`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    val info =
      EditorInfo().apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      }
    val inputMethod = service.onCreateInputMethodInterface() as InputMethodService.InputMethodImpl
    inputMethod.startInput(null, info)
    assertEquals(info, service.currentInputEditorInfo)
    var cancelled = false
    var result: ImeCommitResult? = null
    service.commitText(SECRET, null, isCancelled = { cancelled }, trace = true) { result = it }
    shadowOf(Looper.getMainLooper()).idle()
    service.onUpdateSelection(0, 0, 1, 1, -1, -1)
    val selection = service.traceSnapshot().last()
    assertTrue(selection.contains("event=onUpdateSelection"))
    assertTrue(selection.endsWith("secure=true"))
    for (field in
      listOf(
        "oldSelStart=",
        "oldSelEnd=",
        "newSelStart=",
        "newSelEnd=",
        "candidatesStart=",
        "candidatesEnd=",
      )) assertFalse(
      selection.contains(field),
    )
    val start = service.traceSnapshot().single { it.contains("event=commitStart") }
    assertTrue(start.contains("secure=true"))
    assertFalse(start.contains("textLength="))
    assertFalse(start.contains("units="))
    cancelled = true
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
    val finish = requireNotNull(result).trace!!.last()
    assertTrue(finish.contains("event=commitFinish"))
    assertFalse(finish.contains("insertedLength="))
  }

  @Test
  fun `default commits omit snapshots`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    var cancelled = false
    var result: ImeCommitResult? = null
    service.commitText(SECRET, null, isCancelled = { cancelled }) { result = it }
    shadowOf(Looper.getMainLooper()).idle()
    cancelled = true
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
    assertEquals(null, requireNotNull(result).trace)
  }

  companion object {
    private const val SECRET = "NeverLogEditorText"
  }
}
