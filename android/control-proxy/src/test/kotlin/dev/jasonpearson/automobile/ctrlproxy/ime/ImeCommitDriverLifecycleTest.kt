package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverLifecycleTest : ImeCommitDriverFixtures() {
  @Test
  fun `cancel after a commit syncs editor before restore and completion`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }
    val driver = driver(sink)
    driver.commit(ImeCommitRequest("`a` after", PRIOR_IME_ID)) { result ->
      sink.events.add("complete")
      assertTrue(result.partialApplication)
      assertEquals(3, result.committedUnits)
    }
    sink.runUntil { sink.readSizes.isNotEmpty() }
    assertEquals(listOf("char", "char", "char", "finish", "read"), sink.events)

    driver.cancel()

    assertEquals(listOf("sync", "switch", "complete"), sink.events.takeLast(3))
  }

  @Test
  fun `cancel after commit marks partial when editor sync cannot confirm quiescence`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)
    sink.readText = { _, _ -> "`a`" }
    val driver = driver(sink)
    var result: ImeCommitResult? = null
    driver.commit(ImeCommitRequest("`a` after", PRIOR_IME_ID)) {
      result = it
    }

    driver.cancel()

    assertEquals(1, sink.syncCalls)
    assertTrue(result!!.partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `successful commit finishes composition after the last char and before restoring`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    commit(sink, "ab", PRIOR_IME_ID)

    assertEquals(listOf("char", "char", "finish", "sync", "switch"), sink.events)
  }

  @Test
  fun `commit without an IME switch still finishes composition`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    commit(sink, "ab", priorImeId = null)

    assertEquals(listOf("char", "char", "finish", "sync"), sink.events)
  }

  @Test
  fun `editor sync barrier runs before prior IME is restored`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertTrue(result.success)
    assertTrue(sink.events.indexOf("sync") < sink.events.indexOf("switch"))
  }

  @Test
  fun `sync failure reports failure after committing all chars and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost while syncing editor state", result.error)
    assertEquals(listOf("a", "b"), sink.committedChars)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertFalse("sync" in sink.events)
    assertTrue(result.partialApplication)
  }

  @Test
  fun `persistent sync loss after full dispatch retries a bounded number of times`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals(ImeCommitDriver.SYNC_LOST_ERROR, result.error)
    assertTrue(result.partialApplication)
    assertEquals(2, result.committedUnits)
    // One barrier, the bounded retries, then complete()'s pre-restore barrier.
    assertEquals(1 + ImeCommitDriver.SYNC_RETRY_ATTEMPTS + 1, sink.syncCalls)
    assertEquals(
      List(ImeCommitDriver.SYNC_RETRY_ATTEMPTS) { ImeCommitDriver.SYNC_RETRY_DELAY_MS },
      sink.delays,
    )
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `transient sync loss after every key event reports success once the barrier re-syncs`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSyncCalls = 1)
    var result: ImeCommitResult? = null
    driver(sink).commit(
      ImeCommitRequest("ab", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS),
    ) {
      result = it
    }
    assertNull(result)
    assertTrue(sink.switchedImeIds.isEmpty())

    sink.drain()

    val outcome = requireNotNull(result)
    assertTrue(outcome.success)
    assertNull(outcome.error)
    assertFalse(outcome.partialApplication)
    assertEquals(listOf("a", "b"), sink.sentKeyUnits)
    assertEquals(2, sink.syncCalls)
    assertEquals(listOf(ImeCommitDriver.SYNC_RETRY_DELAY_MS), sink.delays)
    assertEquals(listOf("sync", "switch"), sink.events)
  }

  @Test
  fun `transient sync loss after a full text commit reports success`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSyncCalls = 2)

    val result = commit(sink, "ab", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals(listOf("a", "b"), sink.committedChars)
    assertEquals(3, sink.syncCalls)
    assertEquals(listOf("char", "char", "finish", "sync", "switch"), sink.events)
  }

  @Test
  fun `sync retry is skipped when a round-trip no longer fits before the deadline`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSyncCalls = 1)
    var result: ImeCommitResult? = null
    driver(sink).commit(
      ImeCommitRequest("ab", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS),
      deadlineMs = ImeCommitDriver.SYNC_RETRY_RESERVE_MS,
    ) {
      result = it
    }

    val outcome = requireNotNull(result)
    assertFalse(outcome.success)
    assertEquals(ImeCommitDriver.SYNC_LOST_ERROR, outcome.error)
    assertTrue(outcome.partialApplication)
    assertTrue(sink.delays.isEmpty())
  }

  @Test
  fun `sync retry is skipped after cancellation`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failSync = true)
    var cancelled = false
    sink.afterKeyUnit = { if (sink.sentKeyUnits.size == 2) cancelled = true }
    var result: ImeCommitResult? = null
    driver(sink).commit(
      ImeCommitRequest(
        "ab",
        PRIOR_IME_ID,
        isCancelled = { cancelled },
        delivery = ImeTextDelivery.KEY_EVENTS,
      ),
    ) {
      result = it
    }

    assertEquals(ImeCommitDriver.SYNC_LOST_ERROR, requireNotNull(result).error)
    assertTrue(sink.delays.isEmpty())
  }

  @Test
  fun `cancelled conversion poll cannot resume typing or report twice`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }
    val driver = driver(sink)
    val results = mutableListOf<ImeCommitResult>()

    driver.commit(
      ImeCommitRequest("`a` after", PRIOR_IME_ID),
      deadlineMs = sink.nowMs() + CtrlProxyIme.commitTimeoutMs(24_500L, 9),
    ) {
      results.add(it)
    }
    sink.runUntil { sink.readSizes.isNotEmpty() }
    assertEquals("`a`", sink.committedChars.joinToString(""))
    driver.cancel()
    sink.drain()

    assertEquals("`a`", sink.committedChars.joinToString(""))
    assertEquals(1, results.size)
    assertFalse(results.single().success)
    assertTrue(results.single().partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `deadline stops delayed continuation after partial commit`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }
    val results = mutableListOf<ImeCommitResult>()

    driver(sink).commit(ImeCommitRequest("`a` after", PRIOR_IME_ID), deadlineMs = 10L) {
      results.add(it)
    }
    sink.runUntil { sink.readSizes.isNotEmpty() }
    // Exhaust active work after excluding both realistic typing pauses and the queued conversion
    // poll.
    sink.clockMs = sink.delays.sum() + 10L
    sink.drain()

    assertEquals("`a`", sink.committedChars.joinToString(""))
    assertEquals("IME commit deadline exceeded", results.single().error)
    assertTrue(results.single().partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `external cancellation stops a queued conversion poll before the next character`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }
    var cancelled = false
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("`a` after", PRIOR_IME_ID, isCancelled = { cancelled })) {
      result = it
    }

    sink.runUntil { sink.readSizes.isNotEmpty() }
    assertEquals("`a`", sink.committedChars.joinToString(""))
    cancelled = true
    sink.drain()

    assertEquals("`a`", sink.committedChars.joinToString(""))
    assertEquals("IME commit cancelled", result?.error)
    assertTrue(result!!.partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `pre-cancelled request never mutates the editor`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("late text", PRIOR_IME_ID, isCancelled = { true })) {
      result = it
    }

    assertEquals("IME commit cancelled", result?.error)
    assertTrue(sink.committedChars.isEmpty())
    assertFalse(result!!.partialApplication)
  }
}
