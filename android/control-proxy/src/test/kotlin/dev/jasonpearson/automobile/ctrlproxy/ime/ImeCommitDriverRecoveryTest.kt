package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverRecoveryTest : ImeCommitDriverFixtures() {
  @Test
  fun `consume on space with restart continues remaining text`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.restarting = true
    sink.afterCommit = {
      if (sink.committedChars.last() == " ") {
        sink.editorText = ""
        sink.generation++
      }
    }
    val result = commit(sink, "ab cd", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.error)
    assertTrue(result.editorConsumed)
    assertEquals("cd", result.insertedText)
    assertEquals("cd", sink.editorText)
    assertEquals(listOf("a", "b", " ", "c", "d"), sink.committedChars)
    assertEquals(5, result.committedUnits)
  }

  @Test
  fun `consume on space without restart fails without resending consumed units`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.restarting = false
    sink.afterCommit = {
      if (sink.committedChars.last() == " ") {
        sink.editorText = ""
        sink.generation++
      }
    }
    val result = commit(sink, "ab cd", PRIOR_IME_ID)
    assertEquals(NONE_APPLIED_ERROR, result.error)
    assertFalse(result.success)
    assertTrue(result.partialApplication)
    assertEquals("", result.insertedText)
    assertEquals("", sink.editorText)
    assertEquals("ab ", sink.committedChars.joinToString(""))
  }

  @Test
  fun `password restart resends only missing visible prefix units without reporting text`() {
    val sink =
      FakeImeCommitSink(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
    sink.editorText = ""
    sink.beforeCommit = { if (it == 2) sink.stale = true }
    sink.beforeContinuation = {
      if (sink.stale) {
        sink.generation++
        sink.stale = false
      }
    }
    val result = commit(sink, "hunter2", PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals("hunter2", sink.editorText)
    assertEquals("hunter2", sink.appliedChars.joinToString(""))
    assertNull(result.insertedText)
  }

  @Test
  fun `same generation autoformat reports actual inserted delta`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = { if (sink.editorText == "hello") sink.editorText = "HELLO" }
    val result = commit(sink, "hello", PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals("HELLO", result.insertedText)
  }

  @Test
  fun `password never reports an inserted delta on success or failure`() {
    val inputTypes =
      listOf(
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
      )
    for (inputType in inputTypes) {
      for (failAt in listOf(null, 2)) {
        val sink = FakeImeCommitSink(inputType, failAtCommitIndex = failAt)
        sink.editorText = ""
        assertNull(
          commit(sink, "secret", PRIOR_IME_ID).insertedText,
        )
        assertTrue(sink.editorReads > 0)
      }
    }
  }

  @Test
  fun `hard deadline caps excluded settle waits`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.advanceClockOnDrain = true
    var result: ImeCommitResult? = null
    driver(sink).commit(
      ImeCommitRequest("@person tail", PRIOR_IME_ID),
      deadlineMs = 1L,
      hardDeadlineMs = 100L,
    ) {
      result = it
    }
    sink.drain()
    assertEquals("IME commit deadline exceeded", result?.error)
    assertEquals("@person ", sink.committedChars.joinToString(""))
    assertTrue(sink.clockMs <= 100L)
  }

  @Test
  fun `unreadable baseline restart continues but non restart disconnects`() {
    for (restart in listOf(true, false)) {
      val sink = restartingSink("existing:", restart)
      sink.editorText = null
      sink.advanceClockOnDrain = true
      val result = commit(sink, "line one", PRIOR_IME_ID)
      assertEquals(restart, result.success)
      if (!restart) assertEquals("Editor disconnected during IME commit", result.error)
      assertNull(result.insertedText)
      assertEquals(if (restart) 8 else 5, sink.committedChars.size)
    }
  }

  @Test
  fun `unreadable reconnect waits its bounded window then continues on restart`() {
    val sink = restartingSink("existing:", true, 2)
    sink.advanceClockOnDrain = true
    sink.beforeContinuation = {
      sink.generation = 1
      sink.stale = true
    }
    val result = commit(sink, "line one", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.insertedText)
    assertEquals(8, sink.committedChars.size)
    assertTrue(sink.clockMs >= 2_045L)
    assertTrue(sink.clockMs <= 4_085L)
  }

  @Test
  fun `reconnect cannot resume more than three genuinely progressing prefixes`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = "baseline:"
    val lostAtPrefixes = mutableSetOf<String>()
    sink.afterCommit = {
      val prefix = requireNotNull(sink.editorText).dropLast(1)
      if (sink.committedChars.last() == " " && lostAtPrefixes.add(prefix)) {
        sink.editorText = prefix
        sink.generation++
      }
    }
    val result = commit(sink, "a b c d e", PRIOR_IME_ID)
    assertFalse(result.success)
    assertTrue(requireNotNull(result.error).contains("resume limit exceeded"))
    assertEquals(4, lostAtPrefixes.size)
    assertEquals(11, sink.committedChars.size)
    assertEquals("baseline:a b c d", sink.editorText)
  }

  @Test
  fun `reconnect polling stops at the hard deadline`() {
    val sink = restartingSink("existing:", true)
    sink.advanceClockOnDrain = true
    sink.beforeContinuation = {
      sink.generation = 1
      sink.stale = true
    }
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("line one", PRIOR_IME_ID), hardDeadlineMs = 100L) {
      result = it
    }
    sink.drain()
    assertFalse(requireNotNull(result).success)
    assertEquals(100L, sink.clockMs)
    assertEquals(5, sink.committedChars.size)
  }

  @Test
  fun `capped baseline and rewritten baseline continue on restart without resend`() {
    val capped = restartingSink("x".repeat(20_000), true)
    val cappedResult = commit(capped, "line one", PRIOR_IME_ID)
    assertTrue(cappedResult.success)
    assertNull(cappedResult.insertedText)
    assertEquals(8, capped.committedChars.size)
    val rewritten = restartingSink("existing:", true)
    rewritten.beforeContinuation = {
      rewritten.generation = 1
      rewritten.stale = false
      rewritten.editorText = "changed"
    }
    val result = commit(rewritten, "line one", PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals(8, rewritten.committedChars.size)
    assertNull(result.insertedText)
  }

  @Test
  fun `restart preserves confirmed prefix and rebuilds line state`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = "existing:"
    sink.beforeCommit = { index -> if (index == 2) sink.stale = true }
    sink.beforeContinuation = {
      if (sink.stale) {
        sink.generation++
        sink.stale = false
      }
    }
    val text = "line one\n> body"
    val result = commit(sink, text, PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals(text, result.insertedText)
    assertEquals(text, sink.appliedChars.joinToString(""))
    assertEquals(text.length, result.committedUnits)
    assertTrue(sink.delays.contains(ImeCommitDriver.SETTLE_AFTER_CONVERSION_MS))
  }

  @Test
  fun `one in flight blocking sync consumes reserve without another blocking read`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterSync = { sink.clockMs = 2_099L }
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("hello", PRIOR_IME_ID), hardDeadlineMs = 100L) {
      result = it
    }
    assertEquals("IME commit deadline exceeded", result?.error)
    assertEquals(1, sink.syncCalls)
    assertEquals(1, sink.editorReads)
    assertEquals("hello", sink.editorText)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }
}
