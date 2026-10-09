package dev.jasonpearson.automobile.ctrlproxy.ime.session

import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ImeOp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InputConnectionDriverTest {
  @Test
  fun `every operation maps to the matching connection call`() {
    val connection = RecordingConnection()
    val ops =
      listOf(
        ImeOp.CommitText("a"),
        ImeOp.SetComposingText("b"),
        ImeOp.FinishComposingText,
        ImeOp.SetComposingRegion(1, 2),
        ImeOp.SetSelection(2, 2),
        ImeOp.DeleteSurroundingText(2, 1),
        ImeOp.SendKey(67),
        ImeOp.PerformEditorAction(6),
        ImeOp.BeginBatchEdit,
        ImeOp.EndBatchEdit,
      )

    assertTrue(InputConnectionDriver(connection).execute(ops))
    assertEquals(
      listOf(
        "commit:a",
        "compose:b:1",
        "finish",
        "region:1:2",
        "selection:2:2",
        "delete:2:1",
        "key:67",
        "action:6",
        "begin",
        "end",
      ),
      connection.calls,
    )
  }

  @Test
  fun `execution stops at first failed operation`() {
    val connection = RecordingConnection(failOn = "compose:b:1")

    assertFalse(
      InputConnectionDriver(connection)
        .execute(listOf(ImeOp.CommitText("a"), ImeOp.SetComposingText("b"), ImeOp.CommitText("c"))),
    )
    assertEquals(listOf("commit:a", "compose:b:1"), connection.calls)
  }

  @Test
  fun `failed operation closes every successfully opened batch`() {
    val connection = RecordingConnection(failOn = "compose:b:2")

    assertFalse(
      InputConnectionDriver(connection)
        .execute(
          listOf(
            ImeOp.BeginBatchEdit,
            ImeOp.SetComposingText("b", 2),
            ImeOp.CommitText("c"),
            ImeOp.EndBatchEdit,
          ),
        ),
    )
    assertEquals(listOf("begin", "compose:b:2", "end"), connection.calls)
  }

  @Test
  fun `declined batch still executes contained edits without an end call`() {
    val connection = RecordingConnection(failOn = "begin")

    assertTrue(
      InputConnectionDriver(connection)
        .execute(
          listOf(
            ImeOp.BeginBatchEdit,
            ImeOp.CommitText("hello"),
            ImeOp.CommitText(" "),
            ImeOp.EndBatchEdit,
          ),
        ),
    )
    assertEquals(listOf("begin", "commit:hello", "commit: "), connection.calls)
  }

  @Test
  fun `selection snapshot distinguishes unavailable cursor text from empty text`() {
    val tracker = SelectionTracker()
    tracker.reset(4, 4)

    val snapshot = tracker.snapshot(RecordingConnection(missingBeforeText = true))

    assertEquals("", snapshot.textBeforeCursor)
    assertFalse(snapshot.textBeforeCursorAvailable)
    assertEquals(4, snapshot.selectionStart)
  }

  @Test
  fun `throwing operation closes every successfully opened batch`() {
    val connection = RecordingConnection(throwOn = "compose:b:1")

    try {
      InputConnectionDriver(connection)
        .execute(listOf(ImeOp.BeginBatchEdit, ImeOp.SetComposingText("b"), ImeOp.EndBatchEdit))
      throw AssertionError("expected connection failure")
    } catch (failure: IllegalStateException) {
      assertEquals("compose:b:1", failure.message)
    }

    assertEquals(listOf("begin", "compose:b:1", "end"), connection.calls)
  }

  private class RecordingConnection(
    private val failOn: String? = null,
    private val throwOn: String? = null,
    private val missingBeforeText: Boolean = false,
  ) : ImeConnection {
    val calls = mutableListOf<String>()

    private fun record(call: String): Boolean {
      calls += call
      if (call == throwOn) throw IllegalStateException(call)
      return call != failOn
    }

    override fun commitText(text: String) = record("commit:$text")

    override fun setComposingText(text: String, newCursorPosition: Int) =
      record("compose:$text:$newCursorPosition")

    override fun finishComposingText() = record("finish")

    override fun setComposingRegion(start: Int, end: Int) = record("region:$start:$end")

    override fun setSelection(start: Int, end: Int) = record("selection:$start:$end")

    override fun deleteSurroundingText(before: Int, after: Int) = record("delete:$before:$after")

    override fun sendDownUpKey(keyCode: Int) = record("key:$keyCode")

    override fun performEditorAction(actionId: Int) = record("action:$actionId")

    override fun beginBatchEdit() = record("begin")

    override fun endBatchEdit() = record("end")

    override fun textBeforeCursor(max: Int) = ""

    override fun textBeforeCursorOrNull(max: Int): String? =
      if (missingBeforeText) null else textBeforeCursor(max)

    override fun textAfterCursor(max: Int) = ""
  }
}
