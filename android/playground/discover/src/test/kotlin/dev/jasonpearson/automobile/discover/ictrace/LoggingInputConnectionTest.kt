package android.view.inputmethod

import dev.jasonpearson.automobile.discover.ictrace.IcTraceRecorder
import dev.jasonpearson.automobile.discover.ictrace.LoggingInputConnection
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

// The Android SDK's JVM stub has no delegation behavior. This test-side wrapper
// models InputConnectionWrapper's forwarding without Robolectric.
open class InputConnectionWrapper(private var target: InputConnection, mutable: Boolean) :
  InputConnection by target {
  open fun setTarget(target: InputConnection?) {
    this.target = requireNotNull(target)
  }

  override fun getCursorCapsMode(reqModes: Int): Int = target.getCursorCapsMode(reqModes)

  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean =
    target.commitText(text, newCursorPosition)

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
  companion object {
    private val modernDelegated = mutableListOf<String>()
    private lateinit var modernRecorder: IcTraceRecorder
    private lateinit var modernConnection: LoggingInputConnection

    @BeforeClass
    @JvmStatic
    fun initializeInputConnectionClasses() {
      val base =
        Proxy.newProxyInstance(
          InputConnection::class.java.classLoader,
          arrayOf(InputConnection::class.java),
        ) { _, method, _ ->
          if (method.returnType == Boolean::class.javaPrimitiveType) false else null
        } as InputConnection
      val connection =
        LoggingInputConnection(base, IcTraceRecorder(nowMs = { 0L }), { false }) {
          intArrayOf(0, 0, -1, -1)
        }
      connection.commitText("", 1, null)
      connection.setComposingText("", 1, null)
      connection.replaceText(0, 0, "", 1, null)
      connection.setSelection(0, 0)
      connection.getSelectedText(0)

      modernDelegated.clear()
      val modernBase =
        Proxy.newProxyInstance(
          InputConnection::class.java.classLoader,
          arrayOf(InputConnection::class.java),
        ) { _, method, args ->
          modernDelegated += "${method.name}:${args?.size}"
          true
        } as InputConnection
      modernRecorder = IcTraceRecorder(nowMs = { 0L })
      modernConnection =
        LoggingInputConnection(modernBase, modernRecorder, { false }) { intArrayOf(0, 0, -1, -1) }
    }
  }

  @Test
  fun `replacing the wrapper target updates logged and unlogged forwarding`() {
    val calls = mutableListOf<String>()
    fun target(name: String): InputConnection =
      Proxy.newProxyInstance(
        InputConnection::class.java.classLoader,
        arrayOf(InputConnection::class.java),
      ) { _, method, _ ->
        calls += "$name:${method.name}"
        if (method.name == "getCursorCapsMode") 7 else true
      } as InputConnection
    val recorder = IcTraceRecorder(nowMs = { 0L })
    val connection =
      LoggingInputConnection(target("first"), recorder, { false }) { intArrayOf(0, 0, -1, -1) }
    connection.setTarget(target("second"))

    assertTrue(connection.commitText("a", 1))
    assertTrue(connection.commitText("b", 1, null))
    assertEquals(7, connection.getCursorCapsMode(1))
    assertEquals(
      listOf("second:commitText", "second:commitText", "second:getCursorCapsMode"),
      calls,
    )
    assertEquals(listOf("commitText", "commitText"), recorder.snapshot().map { it.call })
  }

  @Test
  fun `legacy mutations editor operations and reads retain forwarding and logging`() {
    val delegated = mutableListOf<String>()
    val base =
      Proxy.newProxyInstance(
        InputConnection::class.java.classLoader,
        arrayOf(InputConnection::class.java),
      ) { _, method, _ ->
        delegated += method.name
        when (method.name) {
          "getTextBeforeCursor" -> "before"
          "getTextAfterCursor" -> "after"
          "getSelectedText" -> "selected"
          "getCursorCapsMode" -> 7
          else -> false
        }
      } as InputConnection
    val recorder = IcTraceRecorder(nowMs = { 0L })
    val connection = LoggingInputConnection(base, recorder, { false }, { intArrayOf(2, 4, 1, 5) })

    assertLegacyMutationResults(connection)
    assertEquals("before", connection.getTextBeforeCursor(6, 1))
    assertEquals("after", connection.getTextAfterCursor(5, 2))
    assertEquals("selected", connection.getSelectedText(3))

    val events = recorder.snapshot()
    assertEquals(expectedLegacyEvents(), events.map { Triple(it.call, it.args, it.readValue) })
    assertEquals(events.map { it.call }, delegated)
    events.forEach {
      assertEquals(
        listOf(2, 4, 1, 5),
        listOf(it.selectionStart, it.selectionEnd, it.composingStart, it.composingEnd),
      )
      assertEquals(if (it.readValue == null) false else null, it.result)
    }
    assertEquals(7, connection.getCursorCapsMode(1))
    assertEquals("getCursorCapsMode", delegated.last())
    assertEquals(events, recorder.snapshot())
  }

  private fun assertLegacyMutationResults(connection: InputConnection) {
    assertFalse(connection.commitText("abc", 2))
    assertFalse(connection.setComposingText("de", 1))
    assertFalse(connection.setComposingRegion(1, 5))
    assertFalse(connection.finishComposingText())
    assertFalse(connection.deleteSurroundingText(2, 3))
    assertFalse(connection.deleteSurroundingTextInCodePoints(4, 5))
    assertFalse(connection.sendKeyEvent(null))
    assertFalse(connection.performEditorAction(6))
    assertFalse(connection.commitCompletion(null))
    assertFalse(connection.commitCorrection(null))
    assertFalse(connection.setSelection(2, 4))
    assertFalse(connection.beginBatchEdit())
    assertFalse(connection.endBatchEdit())
    assertFalse(connection.performContextMenuAction(9))
  }

  private fun expectedLegacyEvents(): List<Triple<String, String, String?>> =
    listOf(
      Triple("commitText", "text=length=3, newCursorPosition=2", null),
      Triple("setComposingText", "text=length=2, newCursorPosition=1", null),
      Triple("setComposingRegion", "start=1, end=5", null),
      Triple("finishComposingText", "", null),
      Triple("deleteSurroundingText", "beforeLength=2, afterLength=3", null),
      Triple("deleteSurroundingTextInCodePoints", "beforeLength=4, afterLength=5", null),
      Triple("sendKeyEvent", "keyCode=null, action=null", null),
      Triple("performEditorAction", "actionCode=6", null),
      Triple("commitCompletion", "id=null, position=null, text=null", null),
      Triple("commitCorrection", "offset=null, oldText=null, newText=null", null),
      Triple("setSelection", "start=2, end=4", null),
      Triple("beginBatchEdit", "", null),
      Triple("endBatchEdit", "", null),
      Triple("performContextMenuAction", "id=9", null),
      Triple("getTextBeforeCursor", "length=6, flags=1", "length=6"),
      Triple("getTextAfterCursor", "length=5, flags=2", "length=5"),
      Triple("getSelectedText", "flags=3", "length=8"),
    )

  @Test
  fun `modern text mutations delegate and record`() {
    val delegated = modernDelegated
    val recorder = modernRecorder
    val connection = modernConnection

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
