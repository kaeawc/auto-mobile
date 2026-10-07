package dev.jasonpearson.automobile.ctrlproxy

import android.view.inputmethod.EditorInfo
import dev.jasonpearson.automobile.ctrlproxy.CtrlProxy.ImeActionStep
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
import dev.jasonpearson.automobile.ctrlproxy.ime.session.ImeConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImeActionStepTest {
  private class RecordingConnection : ImeConnection {
    val calls = mutableListOf<Int>()
    var accepted = true

    override fun performEditorAction(actionId: Int): Boolean {
      calls += actionId
      return accepted
    }

    override fun commitText(text: String): Boolean = error("Unexpected commit")

    override fun setComposingText(text: String, newCursorPosition: Int): Boolean =
      error("Unexpected composition")

    override fun finishComposingText(): Boolean = error("Unexpected composition")

    override fun setComposingRegion(start: Int, end: Int): Boolean = error("Unexpected composition")

    override fun setSelection(start: Int, end: Int): Boolean = error("Unexpected selection")

    override fun deleteSurroundingText(before: Int, after: Int): Boolean =
      error("Unexpected deletion")

    override fun sendDownUpKey(keyCode: Int): Boolean = error("Unexpected key")

    override fun beginBatchEdit(): Boolean = error("Unexpected batch")

    override fun endBatchEdit(): Boolean = error("Unexpected batch")

    override fun textBeforeCursor(max: Int): String = error("Unexpected read")

    override fun textAfterCursor(max: Int): String = error("Unexpected read")
  }

  @Test
  fun `active started IME dispatches NEXT and PREVIOUS through its connection`() {
    val connection = RecordingConnection()
    for (actionId in listOf(EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_PREVIOUS)) {
      assertEquals(true, CtrlProxyIme.dispatchNavigationAction(actionId, true, true, connection))
    }
    assertEquals(
      listOf(EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_PREVIOUS),
      connection.calls,
    )
    connection.accepted = false
    assertEquals(
      false,
      CtrlProxyIme.dispatchNavigationAction(EditorInfo.IME_ACTION_NEXT, true, true, connection),
    )
    assertNull(
      CtrlProxyIme.dispatchNavigationAction(EditorInfo.IME_ACTION_NEXT, false, true, connection)
    )
    assertNull(
      CtrlProxyIme.dispatchNavigationAction(EditorInfo.IME_ACTION_NEXT, true, false, connection)
    )
    assertNull(CtrlProxyIme.dispatchNavigationAction(EditorInfo.IME_ACTION_NEXT, true, true, null))
    for (actionId in
      listOf(
        EditorInfo.IME_ACTION_DONE,
        EditorInfo.IME_ACTION_GO,
        EditorInfo.IME_ACTION_SEND,
        EditorInfo.IME_ACTION_SEARCH,
      )) {
      assertNull(CtrlProxyIme.dispatchNavigationAction(actionId, true, true, connection))
    }
    assertEquals(3, connection.calls.size)
  }

  private val actions = listOf("done", "go", "send", "search", "next", "previous")

  @Test
  fun `navigation uses editor actions when the IME connection is available`() {
    for (sdkInt in listOf(29, 30)) {
      assertEquals(ImeActionStep.EDITOR_NEXT, ImeActionStep.select("next", true, sdkInt, true))
      assertEquals(
        ImeActionStep.EDITOR_PREVIOUS,
        ImeActionStep.select("previous", true, sdkInt, true),
      )
      for (action in listOf("done", "go", "send", "search")) {
        assertEquals(
          if (sdkInt >= 30) ImeActionStep.IME_ENTER else ImeActionStep.KEYCODE_ENTER,
          ImeActionStep.select(action, true, sdkInt, true),
        )
      }
    }
  }

  @Test
  fun `live editor connection permits navigation without an accessibility focus node`() {
    assertEquals(ImeActionStep.EDITOR_NEXT, ImeActionStep.select("next", false, 30, true))
    assertEquals(ImeActionStep.EDITOR_PREVIOUS, ImeActionStep.select("previous", false, 30, true))
    for (action in listOf("done", "go", "send", "search")) {
      assertEquals(ImeActionStep.NO_FOCUSED_EDITABLE, ImeActionStep.select(action, false, 30, true))
    }
  }

  @Test
  fun `only traversal results are approximated`() {
    assertEquals(true, ImeActionStep.select("next", true, 30).approximated)
    assertEquals(true, ImeActionStep.select("previous", true, 30).approximated)
    for (step in
      ImeActionStep.entries.filter { it != ImeActionStep.NEXT && it != ImeActionStep.PREVIOUS }) {
      assertNull(step.approximated)
    }
  }

  @Test
  fun `focus candidates skip disabled invisible noneditable and nonfocusable rows`() {
    val eligible = ImeFocusCandidate(true, true, true, true)
    val rows =
      listOf(
        eligible,
        eligible.copy(isEnabled = false),
        eligible.copy(isVisibleToUser = false),
        eligible.copy(isEditable = false),
        eligible.copy(isFocusable = false),
        eligible,
      )
    assertEquals(listOf(eligible, eligible), rows.filter(::isImeFocusCandidate))
  }

  @Test
  fun `missing editable focus rejects every action before dispatch`() {
    for (sdkInt in listOf(29, 30)) {
      for (action in actions) {
        val step = ImeActionStep.select(action, hasFocusedEditable = false, sdkInt = sdkInt)
        assertEquals("$action on API $sdkInt", ImeActionStep.NO_FOCUSED_EDITABLE, step)
        assertEquals("No focused editable node found for IME action", step.error)
      }
    }
  }

  @Test
  fun `focused editable fields preserve the existing action and API choices`() {
    for (sdkInt in listOf(29, 30)) {
      for (action in actions) {
        val expected =
          when (action) {
            "next" -> ImeActionStep.NEXT
            "previous" -> ImeActionStep.PREVIOUS
            else -> if (sdkInt >= 30) ImeActionStep.IME_ENTER else ImeActionStep.KEYCODE_ENTER
          }
        val step = ImeActionStep.select(action, hasFocusedEditable = true, sdkInt = sdkInt)
        assertEquals("$action on API $sdkInt", expected, step)
        assertNull(step.error)
      }
    }
  }

  @Test
  fun `a focused noneditable node is rejected just like absent focus`() {
    val isFocused = true
    val isEditable = false
    for (action in actions) {
      val step =
        ImeActionStep.select(action, hasFocusedEditable = isFocused && isEditable, sdkInt = 30)
      assertEquals(ImeActionStep.NO_FOCUSED_EDITABLE, step)
      assertEquals("No focused editable node found for IME action", step.error)
    }
  }

  @Test
  fun `unknown actions remain unsupported with editable focus`() {
    assertEquals(ImeActionStep.UNSUPPORTED, ImeActionStep.select("unknown", true, 30))
  }
}
