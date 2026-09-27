package android.view.inputmethod

import dev.jasonpearson.automobile.discover.ictrace.IcTraceRecorder
import dev.jasonpearson.automobile.discover.ictrace.LoggingInputConnection
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The Android SDK's JVM stub has no delegation behavior. This test-side wrapper
// models InputConnectionWrapper's forwarding without Robolectric.
open class InputConnectionWrapper(private val target: InputConnection, mutable: Boolean) :
  InputConnection by target {
  override fun commitText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean = target.commitText(text, newCursorPosition, textAttribute)

  override fun setComposingText(
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean = target.setComposingText(text, newCursorPosition, textAttribute)

  override fun replaceText(
    start: Int,
    end: Int,
    text: CharSequence,
    newCursorPosition: Int,
    textAttribute: TextAttribute?,
  ): Boolean = target.replaceText(start, end, text, newCursorPosition, textAttribute)
}

class LoggingInputConnectionTest {
  @Test
  fun `modern text mutations delegate and record`() {
    val delegated = mutableListOf<String>()
    val base =
      Proxy.newProxyInstance(
        InputConnection::class.java.classLoader,
        arrayOf(InputConnection::class.java),
      ) { _, method, args ->
        delegated += "${method.name}:${args?.size}"
        true
      } as InputConnection
    val recorder = IcTraceRecorder(nowMs = { 0L })
    val connection = LoggingInputConnection(base, recorder, { false }, { intArrayOf(0, 0, -1, -1) })

    assertTrue(connection.commitText("a", 1, null))
    assertTrue(connection.setComposingText("b", 1, null))
    assertTrue(connection.replaceText(0, 1, "c", 1, null))

    assertEquals(listOf("commitText:3", "setComposingText:3", "replaceText:5"), delegated)
    assertEquals(
      listOf("commitText", "setComposingText", "replaceText"),
      recorder.snapshot().map { it.call },
    )
    assertEquals(listOf(true, true, true), recorder.snapshot().map { it.result })
  }
}
