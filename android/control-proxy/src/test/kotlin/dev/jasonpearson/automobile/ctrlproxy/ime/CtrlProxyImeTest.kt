package dev.jasonpearson.automobile.ctrlproxy.ime

import android.inputmethodservice.InputMethodService
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import dev.jasonpearson.automobile.ctrlproxy.ime.session.InputConnectionAdapter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24])
class CtrlProxyImeTest {
  @Test
  fun `input started state uses lifecycle callbacks on API 24`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    assertFalse(service.isInputStarted)
    service.onStartInput(EditorInfo(), false)
    assertTrue(service.isInputStarted)
    service.onFinishInput()
    assertFalse(service.isInputStarted)
  }

  @Test
  fun `input generation and identity track start restart and finish`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    val info =
      EditorInfo().apply {
        packageName = "app"
        fieldId = 7
        inputType = 1
        hintText = "Notes"
      }
    assertEquals(0L, service.inputConnectionGeneration)
    service.onStartInput(info, false)
    val identity = service.inputEditorIdentity
    assertEquals(1L, service.inputConnectionGeneration)
    assertFalse(service.inputStartedByRestart)
    service.onStartInput(info, true)
    assertEquals(2L, service.inputConnectionGeneration)
    assertEquals(identity, service.inputEditorIdentity)
    assertTrue(service.inputStartedByRestart)
    service.onFinishInput()
    assertEquals(3L, service.inputConnectionGeneration)
    assertEquals(null, service.inputEditorIdentity)
    info.fieldId = 8
    service.onStartInput(info, false)
    assertTrue(identity != service.inputEditorIdentity)
  }

  @Test
  fun `finish during active commit neither cancels nor restores but idle finish restores`() {
    val service = Robolectric.buildService(CtrlProxyIme::class.java).create().get()
    val sink = ImeCommitDriverFixtures.FakeImeCommitSink(1)
    val driver = ImeCommitDriver(sink) { listOf(it) }
    var cancellations = 0
    fun set(name: String, value: Any?) {
      CtrlProxyIme::class
        .java
        .getDeclaredField(name)
        .apply { isAccessible = true }
        .set(service, value)
    }
    set("lastDriver", driver)
    set("lastPriorImeId", "prior")
    set("cancelActiveCommit", { _: String -> cancellations++ })
    service.onStartInput(EditorInfo(), false)
    service.onFinishInput()
    assertEquals(0, cancellations)
    assertTrue(sink.switchedImeIds.isEmpty())
    set("cancelActiveCommit", null)
    service.onFinishInput()
    assertEquals(listOf("prior"), sink.switchedImeIds)
  }

  @Test
  fun `request deadline bounds connection wait and reserves sync including tiny budgets`() {
    assertEquals(900L, CtrlProxyIme.connectionDeadlineMs(100L, 900L))
    assertEquals(2_100L, CtrlProxyIme.connectionDeadlineMs(100L, Long.MAX_VALUE))
    assertEquals(7_500L, CtrlProxyIme.driverDeadlineMs(100L, 10_000L))
    assertEquals(101L, CtrlProxyIme.driverDeadlineMs(100L, 500L))
    assertEquals(100L, CtrlProxyIme.driverDeadlineMs(100L, 100L))
    assertEquals(Long.MAX_VALUE, CtrlProxyIme.driverDeadlineMs(100L, Long.MAX_VALUE))
  }

  @Test
  fun `editor sync distinguishes throwing read from completed empty and populated reads`() {
    val service = InputMethodService()
    fun connection(read: () -> CharSequence?) =
      InputConnectionAdapter(
        object : BaseInputConnection(EditText(RuntimeEnvironment.getApplication()), true) {
          override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence? = read()
        },
        service,
      )

    assertFalse(CtrlProxyIme.editorSyncSucceeded(null))
    assertFalse(CtrlProxyIme.editorSyncSucceeded(connection { error("dead connection") }))
    assertTrue(CtrlProxyIme.editorSyncSucceeded(connection { null }))
    assertTrue(CtrlProxyIme.editorSyncSucceeded(connection { "" }))
    assertTrue(CtrlProxyIme.editorSyncSucceeded(connection { "x" }))
    var clockMs = 0L
    assertFalse(
      CtrlProxyIme.editorSyncSucceeded(
        connection {
          clockMs = 2_000L
          null
        },
        nowMs = { clockMs },
      ),
    )
  }

  @Test
  fun `real EditText input connection completes the sync barrier`() {
    val editor = EditText(RuntimeEnvironment.getApplication())
    editor.setText("actual")
    editor.setSelection(editor.text.length)
    val connection = requireNotNull(editor.onCreateInputConnection(EditorInfo()))

    assertTrue(
      CtrlProxyIme.editorSyncSucceeded(InputConnectionAdapter(connection, InputMethodService())),
    )
  }

  @Test
  fun `profile completion waits until posted apply persists selection`() {
    var queued: Runnable? = null
    var persisted = "direct"
    var acknowledged = false

    CtrlProxyIme.postProfileChange(
      post = { action ->
        queued = action
        true
      },
      apply = {
        persisted = "gboard"
        true
      },
      onComplete = { success ->
        assertTrue(success)
        assertEquals("gboard", persisted)
        acknowledged = true
      },
    )

    assertFalse(acknowledged)
    assertEquals("direct", persisted)
    requireNotNull(queued).run()
    assertTrue(acknowledged)
  }
}
