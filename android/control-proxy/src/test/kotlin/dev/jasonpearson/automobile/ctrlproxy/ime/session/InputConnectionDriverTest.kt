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
        "compose:b",
        "finish",
        "region:1:2",
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
    val connection = RecordingConnection(failOn = "compose:b")

    assertFalse(
      InputConnectionDriver(connection)
        .execute(listOf(ImeOp.CommitText("a"), ImeOp.SetComposingText("b"), ImeOp.CommitText("c")))
    )
    assertEquals(listOf("commit:a", "compose:b"), connection.calls)
  }

  private class RecordingConnection(private val failOn: String? = null) : ImeConnection {
    val calls = mutableListOf<String>()

    private fun record(call: String): Boolean {
      calls += call
      return call != failOn
    }

    override fun commitText(text: String) = record("commit:$text")

    override fun setComposingText(text: String) = record("compose:$text")

    override fun finishComposingText() = record("finish")

    override fun setComposingRegion(start: Int, end: Int) = record("region:$start:$end")

    override fun deleteSurroundingText(before: Int, after: Int) = record("delete:$before:$after")

    override fun sendDownUpKey(keyCode: Int) = record("key:$keyCode")

    override fun performEditorAction(actionId: Int) = record("action:$actionId")

    override fun beginBatchEdit() = record("begin")

    override fun endBatchEdit() = record("end")

    override fun textBeforeCursor(max: Int) = ""

    override fun textAfterCursor(max: Int) = ""
  }
}
