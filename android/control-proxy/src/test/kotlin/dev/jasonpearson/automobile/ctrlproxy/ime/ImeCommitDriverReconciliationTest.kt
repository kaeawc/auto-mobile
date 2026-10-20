package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverReconciliationTest : ImeCommitDriverFixtures() {
  @Test
  fun `pure reconciliation distinguishes phase restart and visible prefix`() {
    val units = listOf("a", "b")
    for (postDispatch in listOf(false, true)) {
      assertEquals(
        ImeCommitDriver.Reconciliation.Resume(1),
        ImeCommitDriver.reconcileDecision(
          ImeReconciliationState(postDispatch, false, "", "a", units),
        ),
      )
      assertEquals(
        if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("")
        else ImeCommitDriver.Reconciliation.Consumed(0),
        ImeCommitDriver.reconcileDecision(
          ImeReconciliationState(postDispatch, true, "", "", units),
        ),
      )
      assertEquals(
        if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("ab")
        else ImeCommitDriver.Reconciliation.Continue,
        ImeCommitDriver.reconcileDecision(
          ImeReconciliationState(postDispatch, false, "", "ab", units),
        ),
      )
    }
    for (restart in listOf(false, true)) {
      assertEquals(
        if (restart) ImeCommitDriver.Reconciliation.Consumed(0)
        else ImeCommitDriver.Reconciliation.Fail(NONE_APPLIED_ERROR, ""),
        ImeCommitDriver.reconcileDecision(ImeReconciliationState(false, restart, "", "", units)),
      )
      assertEquals(
        ImeCommitDriver.Reconciliation.Succeed(""),
        ImeCommitDriver.reconcileDecision(ImeReconciliationState(true, restart, "", "", units)),
      )
      assertEquals(
        if (restart) ImeCommitDriver.Reconciliation.Continue
        else ImeCommitDriver.Reconciliation.Fail("Editor disconnected during IME commit", null),
        ImeCommitDriver.reconcileDecision(
          ImeReconciliationState(false, restart, null, null, units),
        ),
      )
      assertEquals(
        if (restart) ImeCommitDriver.Reconciliation.Continue
        else ImeCommitDriver.Reconciliation.Fail("Editor disconnected during IME commit", "AB"),
        ImeCommitDriver.reconcileDecision(ImeReconciliationState(false, restart, "", "AB", units)),
      )
    }
    assertEquals(
      ImeCommitDriver.Reconciliation.Succeed(null),
      ImeCommitDriver.reconcileDecision(ImeReconciliationState(true, false, null, null, units)),
    )
    assertEquals(
      ImeCommitDriver.Reconciliation.Succeed("AB"),
      ImeCommitDriver.reconcileDecision(ImeReconciliationState(true, false, "", "AB", units)),
    )
  }

  @Test
  fun `pure reconciliation consumes only a missing last dispatched newline`() {
    for (postDispatch in listOf(false, true)) {
      for (restart in listOf(false, true)) {
        for (lastResume in listOf(-1, 1, 2)) {
          assertEquals(
            when {
              restart && postDispatch -> ImeCommitDriver.Reconciliation.Succeed("a")
              restart -> ImeCommitDriver.Reconciliation.Consumed(1)
              lastResume == -1 -> ImeCommitDriver.Reconciliation.Resume(1)
              postDispatch -> ImeCommitDriver.Reconciliation.Succeed("a")
              else -> ImeCommitDriver.Reconciliation.DropRejected(1)
            },
            ImeCommitDriver.reconcileDecision(
              ImeReconciliationState(postDispatch, restart, "", "a", listOf("a", "\n"), lastResume),
            ),
          )
        }
        assertEquals(
          ImeCommitDriver.Reconciliation.Resume(1),
          ImeCommitDriver.reconcileDecision(
            ImeReconciliationState(postDispatch, restart, "", "a", listOf("a", "\n", "b")),
          ),
        )
        assertEquals(
          if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("a")
          else ImeCommitDriver.Reconciliation.DropRejected(1),
          ImeCommitDriver.reconcileDecision(
            ImeReconciliationState(postDispatch, restart, "", "a", listOf("a", "\n", "b"), 1),
          ),
        )
      }
    }
  }

  @Test
  fun `pure reconciliation requires resume progress regardless of restart flag`() {
    val units = listOf("a", "b", "c", "d")
    for (postDispatch in listOf(false, true)) {
      for (restart in listOf(false, true)) {
        assertEquals(
          ImeCommitDriver.Reconciliation.Resume(2),
          ImeCommitDriver.reconcileDecision(
            ImeReconciliationState(postDispatch, restart, "", "ab", units, 1),
          ),
        )
        for (lastResume in listOf(2, 3)) {
          assertEquals(
            if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("ab")
            else ImeCommitDriver.Reconciliation.DropRejected(2),
            ImeCommitDriver.reconcileDecision(
              ImeReconciliationState(postDispatch, restart, "", "ab", units, lastResume),
            ),
          )
        }
      }
    }
  }

  @Test
  fun `restart during word run reconciles four captured loss points without duplicate application`() {
    for (lostAt in listOf(7, 5, 10, 16)) {
      val sink = restartingSink("existing:", true, lostAt)
      val text = "line one\nline two\nline three"
      val result = commit(sink, text, PRIOR_IME_ID)
      assertTrue(result.success)
      assertEquals("existing:" + text, sink.editorText)
      assertEquals(text, result.insertedText)
      assertEquals(text, sink.appliedChars.joinToString(""))
      assertEquals(28, result.committedUnits)
    }
  }

  @Test
  fun `finish and same editor non restart with no applied units never resends`() {
    val sink = restartingSink("existing:", false)
    val result = commit(sink, "line one", PRIOR_IME_ID)
    assertFalse(result.editorConsumed)
    assertEquals(NONE_APPLIED_ERROR, result.error)
    assertEquals("existing:", sink.editorText)
    assertEquals("", result.insertedText)
    assertEquals(5, sink.committedChars.size)
  }

  @Test
  fun `missing editor reconnect expires and restores once`() {
    val sink = restartingSink("existing:", true)
    sink.beforeContinuation = {
      sink.generation = 1
      sink.identity = null
    }
    sink.advanceClockOnDrain = true
    val result = commit(sink, "line one", PRIOR_IME_ID)
    assertEquals("Editor disconnected during IME commit", result.error)
    assertTrue(result.partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertEquals(5, sink.committedChars.size)
  }

  @Test
  fun `different identity refuses to send any more units`() {
    val sink = restartingSink("existing:", true)
    sink.beforeContinuation = {
      sink.generation = 1
      sink.identity = "other-editor"
      sink.stale = false
    }
    val result = commit(sink, "line one", PRIOR_IME_ID)
    assertEquals("Editor disconnected during IME commit", result.error)
    assertEquals(5, sink.committedChars.size)
  }

  @Test
  fun `non restart empty baseline with no applied units never resends`() {
    val sink = restartingSink("", false)
    val result = commit(sink, "line one", PRIOR_IME_ID)
    assertEquals(NONE_APPLIED_ERROR, result.error)
    assertEquals(5, sink.committedChars.size)
    assertEquals("", result.insertedText)
  }

  @Test
  fun `autoformat restart continues without resend but non restart disconnects`() {
    for (restart in listOf(true, false)) {
      val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
      sink.editorText = ""
      sink.restarting = restart
      sink.afterCommit = { sink.editorText = sink.editorText?.uppercase() }
      sink.beforeContinuation = { if (sink.generation == 0L) sink.generation++ }
      val result = commit(sink, "ab cd", PRIOR_IME_ID)
      assertEquals(restart, result.success)
      assertEquals(if (restart) "AB CD" else "AB ", result.insertedText)
      assertEquals(if (restart) "ab cd" else "ab ", sink.committedChars.joinToString(""))
      if (!restart) assertEquals("Editor disconnected during IME commit", result.error)
    }
  }

  @Test
  fun `late restart after more than six final polls resumes a visible prefix`() {
    val sink = restartingSink("existing:", true, 2)
    sink.advanceClockOnDrain = true
    sink.beforeContinuation = {
      if (sink.clockMs > 240L && sink.stale) {
        sink.generation++
        sink.stale = false
      }
    }
    val result = commit(sink, "hello", PRIOR_IME_ID)
    assertTrue(result.success)
    assertEquals("existing:hello", sink.editorText)
    assertEquals("hello", result.insertedText)
    assertEquals("hello", sink.appliedChars.joinToString(""))
    assertTrue(sink.clockMs > 240L)
  }

  @Test
  fun `final null forever waits through reconnect window then succeeds unverifiably`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = { sink.stale = true }
    sink.advanceClockOnDrain = true
    val result = commit(sink, "hello", PRIOR_IME_ID)
    assertTrue(result.success)
    assertNull(result.insertedText)
    assertEquals(CtrlProxyIme.INPUT_CONNECTION_TIMEOUT_MS, sink.clockMs)
    assertEquals("hello", sink.committedChars.joinToString(""))
  }

  @Test
  fun `rejected dash restarts stop resending and continue pending digits`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.restarting = true
    sink.afterCommit = {
      if (sink.committedChars.last() == "-") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "12-34", PRIOR_IME_ID)
    assertEquals(2, sink.committedChars.count { it == "-" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("1234", result.insertedText)
    assertEquals("1234", sink.editorText)
  }

  @Test
  fun `stripped final newline succeeds with retained query without resending`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "hello\n", PRIOR_IME_ID)
    assertEquals(1, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("hello", result.insertedText)
    assertEquals("hello", sink.editorText)
  }

  @Test
  fun `non restart lost final newline is resent once`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.restarting = false
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n" && sink.committedChars.count { it == "\n" } == 1) {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "hello\n", PRIOR_IME_ID)
    assertEquals(2, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertFalse(result.editorConsumed)
    assertEquals("hello\n", result.insertedText)
    assertEquals("hello\n", sink.editorText)
  }

  @Test
  fun `stripped mid dispatch newline continues remaining line without resending`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "line one\nline two", PRIOR_IME_ID)
    assertEquals(1, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertTrue(result.editorConsumed)
    assertEquals("line oneline two", result.insertedText)
    assertEquals("line oneline two", sink.editorText)
  }
}
