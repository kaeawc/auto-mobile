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
