package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverNewlineTest : ImeCommitDriverFixtures() {
  @Test
  fun `consumed Enter followed by stale connection reconnects without resending`() {
    val sink = newlineStrippingSink()
    val stripNewline = requireNotNull(sink.afterCommit)
    sink.restarting = true
    sink.afterCommit = {
      stripNewline()
      if (sink.committedChars.last() == "\n") {
        sink.identity = null
        sink.stale = true
      }
    }
    var reconnectPolls = 0
    sink.beforeContinuation = {
      if (sink.stale && ++reconnectPolls == 2) {
        sink.identity = "same-editor"
        sink.stale = false
        sink.generation++
      }
    }
    val result = commit(sink, "hello\nworld", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals(2, reconnectPolls)
    assertEquals("hello\nworld", sink.committedChars.joinToString(""))
    assertEquals(1, sink.committedChars.count { it == "\n" })
    assertEquals("helloworld", sink.editorText)
    assertEquals("helloworld", result.insertedText)
    assertEquals(11, result.committedUnits)
  }

  @Test
  fun `tolerated newline rejection still reconciles a later restart lost h`() {
    assertRejectedNewlineThenLostH(true)
  }

  @Test
  fun `tolerated newline rejection still reconciles a later non restart lost h`() {
    assertRejectedNewlineThenLostH(false)
  }

  @Test
  fun `tolerated newline rejection without later restart never resends`() {
    val sink = newlineStrippingSink()
    val result = commit(sink, "one\ntwo three", PRIOR_IME_ID)
    assertEquals(1, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("onetwo three", sink.editorText)
    assertEquals("onetwo three", result.insertedText)
    assertEquals(13, result.committedUnits)
  }

  @Test
  fun `four rejected newlines succeed without resending`() {
    val sink = newlineStrippingSink()
    val result = commit(sink, "a\nb\nc\nd\ne", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("abcde", sink.editorText)
    assertEquals("abcde", result.insertedText)
    assertEquals(4, sink.committedChars.count { it == "\n" })
    assertEquals(9, result.committedUnits)
  }

  @Test
  fun `distinct rejected units do not consume the recovery resume budget`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    val rejected = setOf("\n", "\t", ",", ";")
    sink.afterCommit = {
      if (sink.committedChars.last() in rejected) {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "a\nb\tc,d;e", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("abcde", sink.editorText)
    assertEquals("abcde", result.insertedText)
    for (unit in rejected) {
      assertEquals(if (unit == "\n") 1 else 2, sink.committedChars.count { it == unit })
    }
  }

  @Test
  fun `genuinely lost h still recovers after four tolerated newline rejections`() {
    for (restart in listOf(true, false)) {
      val sink = newlineStrippingSink()
      val stripNewline = requireNotNull(sink.afterCommit)
      sink.afterCommit = {
        stripNewline()
        if (sink.committedChars.last() == "h" && sink.committedChars.count { it == "h" } == 1) {
          sink.editorText = requireNotNull(sink.editorText).dropLast(1)
          sink.restarting = restart
          sink.generation++
        }
      }
      val result = commit(sink, "a\nb\nc\nd\nthree", PRIOR_IME_ID)
      assertTrue(result.success)
      assertNull(result.error)
      assertEquals("abcdthree", sink.editorText)
      assertEquals("abcdthree", result.insertedText)
      assertEquals(4, sink.committedChars.count { it == "\n" })
      assertEquals(2, sink.committedChars.count { it == "h" })
      assertEquals(13, result.committedUnits)
    }
  }

  @Test
  fun `send on final newline succeeds with empty delta and no resend`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = ""
        sink.generation++
      }
    }
    val result = commit(sink, "hello\n", PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals("", result.insertedText)
    assertEquals("hello\n", sink.committedChars.joinToString(""))
  }

  @Test
  fun `auto submit after final unit succeeds without reading or typing a new editor`() {
    for (newIdentity in listOf(null, "different-editor")) {
      val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
      sink.editorText = ""
      sink.advanceClockOnDrain = true
      sink.afterCommit = {
        if (sink.committedChars.size == 4) {
          sink.generation++
          sink.identity = newIdentity
          sink.editorText = "new editor content"
        }
      }
      val result = commit(sink, "1234", PRIOR_IME_ID)
      assertTrue(result.success)
      assertNull(result.insertedText)
      assertEquals("1234", sink.committedChars.joinToString(""))
      assertEquals(1, sink.editorReads)
      assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
      assertTrue(sink.clockMs <= 240L)
    }
  }
}
