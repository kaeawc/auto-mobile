package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeCommitDriverTest {
  @Test
  fun `key event delivery sends units without committing text`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    var result: ImeCommitResult? = null
    driver(sink).commit("Ab!", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS) {
      result = it
    }

    assertTrue(result!!.success)
    assertEquals(listOf("A", "b", "!"), sink.sentKeyUnits)
    assertTrue(sink.committedChars.isEmpty())
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `unsupported key event text fails before any event`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.supportedKeyUnits = { units -> units.none { it == "😀" } }
    var result: ImeCommitResult? = null
    driver(sink).commit("a😀", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS) {
      result = it
    }

    val outcome = requireNotNull(result)
    assertFalse(outcome.success)
    assertFalse(outcome.partialApplication)
    assertEquals(0, outcome.committedUnits)
    assertTrue(sink.sentKeyUnits.isEmpty())
  }

  @Test
  fun `key event cancellation reports partial application`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    var cancelled = false
    sink.afterKeyUnit = { cancelled = true }
    var result: ImeCommitResult? = null
    driver(sink).commit(
      "ab",
      PRIOR_IME_ID,
      isCancelled = { cancelled },
      delivery = ImeTextDelivery.KEY_EVENTS,
    ) {
      result = it
    }

    assertEquals(listOf("a"), sink.sentKeyUnits)
    val committed = result!!
    assertTrue(committed.partialApplication)
    assertEquals(1, committed.committedUnits)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `cancel after a commit syncs editor before restore and completion`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }
    val driver = driver(sink)
    driver.commit("`a` after", PRIOR_IME_ID) { result ->
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
    driver.commit("`a` after", PRIOR_IME_ID) { result = it }

    driver.cancel()

    assertEquals(1, sink.syncCalls)
    assertTrue(result!!.partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `text password field commits and prior IME is restored`() {
    assertPasswordCommits(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
  }

  @Test
  fun `visible text password field commits and prior IME is restored`() {
    assertPasswordCommits(
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
    )
  }

  @Test
  fun `web password field commits and prior IME is restored`() {
    assertPasswordCommits(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
  }

  @Test
  fun `number password field commits and prior IME is restored`() {
    assertPasswordCommits(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
  }

  @Test
  fun `password commit failure never echoes the typed text`() {
    val sink =
      FakeImeCommitSink(
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        failAtCommitIndex = 2,
      )

    val result = commit(sink, "s3cr3t", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost during commit", result.error)
    assertFalse(result.error!!.contains("s3"))
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `normal text commits each character in order and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "hello *world*", PRIOR_IME_ID)

    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("hello *world*", sink.committedChars.joinToString(separator = ""))
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertEquals(listOf(45L, 45L), sink.delays)
  }

  @Test
  fun `automation commits complete Unicode graphemes as individual units`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    val family = "👩‍👩‍👧‍👦"
    val flag = "🇺🇸"
    val text = "A😀e\u0301$family${flag}B"

    val result = commit(sink, text, PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals(listOf("A", "😀", "e\u0301", family, flag, "B"), sink.committedChars)
    assertEquals(text, sink.committedChars.joinToString(""))
    assertEquals(6, result.committedUnits)
  }

  @Test
  fun `unicode corpus commits exact text without lone UTF-16 surrogates`() {
    unicodeCorpus().forEach { input ->
      val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

      val result = commit(sink, input, PRIOR_IME_ID)

      assertTrue("Failed input: $input", result.success)
      assertEquals(input, sink.committedChars.joinToString(""))
      assertTrue(
        "A commit contained a lone UTF-16 surrogate for input: $input",
        sink.committedChars.all { it.hasWellFormedUtf16() },
      )
    }
  }

  @Test
  fun `graphemeSequencesStayTogetherInCommits_asTrackedForIssue7999`() {
    val graphemes = listOf("1️⃣", "e\u0301", "👨‍👩‍👧", "🇯🇵", "👍🏽", "🏳️‍🌈", "👩🏽‍💻")

    graphemes.forEach { grapheme ->
      val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

      val result = commit(sink, grapheme, PRIOR_IME_ID)

      assertTrue("Failed grapheme: $grapheme", result.success)
      assertEquals(listOf(grapheme), sink.committedChars)
    }
  }

  @Test
  fun `failed automation unit preserves complete cluster and partial progress`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failAtCommitIndex = 1)

    val result = commit(sink, "e\u0301x", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost during commit", result.error)
    assertEquals(listOf("e\u0301"), sink.committedChars)
    assertTrue(result.partialApplication)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `failed multi code point unit reports possible partial application`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failAtCommitIndex = 0)

    val result = commit(sink, "e\u0301", PRIOR_IME_ID)

    assertFalse(result.success)
    assertTrue(result.partialApplication)
  }

  @Test
  fun `cancellation is checked between grapheme commits`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    var cancelled = false
    sink.afterCommit = { cancelled = true }
    var result: ImeCommitResult? = null

    driver(sink).commit("😀after", PRIOR_IME_ID, isCancelled = { cancelled }) {
      result = it
    }

    sink.drain()
    assertEquals(listOf("😀"), sink.committedChars)
    assertEquals("IME commit cancelled", result?.error)
    assertTrue(result!!.partialApplication)
  }

  @Test
  fun `deadline is checked between grapheme commits`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.afterCommit = { sink.clockMs = 10L }
    sink.advanceClockOnDrain = true
    var result: ImeCommitResult? = null

    driver(sink).commit("👩‍👩‍👧‍👦next", PRIOR_IME_ID, deadlineMs = 10L) {
      result = it
    }

    sink.drain()
    assertEquals(listOf("👩‍👩‍👧‍👦"), sink.committedChars)
    assertEquals("IME commit deadline exceeded", result?.error)
    assertTrue(result!!.partialApplication)
  }

  @Test
  fun `multi-span commit waits for conversion before typing next span`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, call -> if (call <= 2) "`a`" else "abc" }
    var result: ImeCommitResult? = null

    driver(sink).commit("`a` `b`", PRIOR_IME_ID) { result = it }

    sink.runUntil { sink.readSizes.isNotEmpty() }
    assertEquals("`a`", sink.committedChars.joinToString(""))
    assertNull(result)
    sink.drain()
    assertTrue(result!!.success)
    assertEquals("`a` `b`", sink.committedChars.joinToString(""))
    assertEquals(listOf(45L, 40L, 40L, 45L, 45L), sink.delays)
    assertEquals(listOf(3, 3, 3), sink.readSizes)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    assertEquals(listOf("finish", "finish"), sink.events.filter { it == "finish" })
  }

  @Test
  fun `conversion timeout proceeds with next span`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "`a`" }

    val result = commit(sink, "`a``b`", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals("`a``b`", sink.committedChars.joinToString(""))
    assertEquals(12, sink.delays.count { it == 40L })
    assertEquals(13, sink.readSizes.size)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `unconverted suffix read-back waits while full changed read advances`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, call -> if (call == 1) "bc`" else "xyz12" }
    var result: ImeCommitResult? = null

    driver(sink).commit("`abc``b`", PRIOR_IME_ID) { result = it }

    sink.runUntil { sink.readSizes.isNotEmpty() }
    assertNull(result)
    assertEquals("`abc`", sink.committedChars.joinToString(""))
    assertEquals(listOf(45L, 40L), sink.delays)
    sink.drain()
    assertTrue(result!!.success)
    assertEquals(listOf(5, 5), sink.readSizes)
  }

  @Test
  fun `short converted read-back advances immediately near field start`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "abc" }
    var result: ImeCommitResult? = null

    driver(sink).commit("`abc``b`", PRIOR_IME_ID) { result = it }

    sink.drain()
    assertTrue(result!!.success)
    assertEquals("`abc``b`", sink.committedChars.joinToString(""))
    assertEquals(listOf(5), sink.readSizes)
    assertEquals(listOf(45L, 45L), sink.delays)
  }

  @Test
  fun `empty read-back falls back to the bounded settle window`() {
    // Editors without text retrieval return "" (not null) from getTextBeforeCursor; the driver
    // must keep polling to the ceiling rather than treat "" as converted and race ahead.
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "" }

    val result = commit(sink, "`a``b`", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals("`a``b`", sink.committedChars.joinToString(""))
    assertEquals(12, sink.delays.count { it == 40L })
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `null read-back falls back to the bounded settle window`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> null }

    val result = commit(sink, "`a``b`", PRIOR_IME_ID)

    assertTrue(result.success)
    assertEquals(12, sink.delays.count { it == 40L })
    assertEquals(13, sink.readSizes.size)
  }

  @Test
  fun `settle waits do not exhaust the active commit deadline`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "" }
    sink.advanceClockOnDrain = true
    var result: ImeCommitResult? = null

    driver(sink).commit(
      "`a``b``c``d``e``f``g``h``i` tail",
      PRIOR_IME_ID,
      deadlineMs = 4_000L,
    ) {
      result = it
    }
    sink.drain()

    assertTrue(result!!.success)
    assertEquals(4_770L, sink.clockMs)
    assertEquals("`a``b``c``d``e``f``g``h``i` tail", sink.committedChars.joinToString(""))
  }

  @Test
  fun `realistic typing pauses between double delimiters before conversion`() {
    for (span in listOf("**b1**", "~~gone~~")) {
      val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
      sink.readText = { _, _ -> span }
      var result: ImeCommitResult? = null

      driver(sink).commit("$span tail", PRIOR_IME_ID) { result = it }

      sink.runUntil { sink.readSizes.isNotEmpty() }
      assertEquals(span, sink.committedChars.joinToString(""))
      assertEquals(listOf(span.length), sink.readSizes)
      assertNull(result)
      sink.drain()
      assertTrue(result!!.success)
    }
  }

  @Test
  fun `plain text and one span commit without polling`() {
    for (text in listOf("plain", "`code`", "")) {
      val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

      val result = commit(sink, text, PRIOR_IME_ID)

      assertTrue(result.success)
      assertEquals(text, sink.committedChars.joinToString(""))
      assertEquals(if (text == "`code`") listOf(45L) else emptyList<Long>(), sink.delays)
      assertTrue(sink.readSizes.isEmpty())
      assertEquals(1, sink.events.count { it == "finish" })
      assertEquals(listOf("finish", "sync", "switch"), sink.events.takeLast(3))
    }
  }

  @Test
  fun `null prior IME commits without switching keyboards`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)

    val result = commit(sink, "abc", priorImeId = null)

    assertTrue(result.success)
    assertEquals(listOf("a", "b", "c"), sink.committedChars)
    assertTrue(sink.switchedImeIds.isEmpty())
  }

  @Test
  fun `missing editor input type fails without committing`() {
    val sink = FakeImeCommitSink(inputType = null)

    val result = commit(sink, "abc", priorImeId = null)

    assertFalse(result.success)
    assertEquals("No active input connection", result.error)
    assertTrue(sink.committedChars.isEmpty())
  }

  @Test
  fun `lost connection during second character fails and restores prior IME`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT, failAtCommitIndex = 1)

    val result = commit(sink, "abc", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Input connection lost during commit", result.error)
    assertEquals(2, result.committedUnits) // The failed second dispatch is conservatively included.
    assertEquals(listOf("a"), sink.committedChars)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  @Test
  fun `restore switches only when a prior IME is provided`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    val driver = driver(sink)

    driver.restoreIfNeeded(PRIOR_IME_ID)
    driver.restoreIfNeeded(null)

    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  private fun assertPasswordCommits(inputType: Int) {
    val sink = FakeImeCommitSink(inputType = inputType)

    val result = commit(sink, "s3cr3t", PRIOR_IME_ID)

    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("s3cr3t", sink.committedChars.joinToString(separator = ""))
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
    driver(sink).commit("ab", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS) {
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
      "ab",
      PRIOR_IME_ID,
      deadlineMs = ImeCommitDriver.SYNC_RETRY_RESERVE_MS,
      delivery = ImeTextDelivery.KEY_EVENTS,
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
      "ab",
      PRIOR_IME_ID,
      isCancelled = { cancelled },
      delivery = ImeTextDelivery.KEY_EVENTS,
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
      "`a` after",
      PRIOR_IME_ID,
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

    driver(sink).commit("`a` after", PRIOR_IME_ID, deadlineMs = 10L) {
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
    driver(sink).commit("`a` after", PRIOR_IME_ID, isCancelled = { cancelled }) {
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
    driver(sink).commit("late text", PRIOR_IME_ID, isCancelled = { true }) {
      result = it
    }

    assertEquals("IME commit cancelled", result?.error)
    assertTrue(sink.committedChars.isEmpty())
    assertFalse(result!!.partialApplication)
  }

  @Test
  fun `realistic typing yields at non-word graphemes while letter and digit runs stay synchronous`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    var result: ImeCommitResult? = null
    driver(sink).commit("a1é!😀b", null) { result = it }
    assertEquals(listOf("a", "1", "é", "!"), sink.committedChars)
    assertNull(result)
    sink.step()
    assertEquals("😀", sink.committedChars.last())
    assertNull(result)
    sink.step()
    assertTrue(result!!.success)
    assertEquals(listOf(45L, 45L), sink.delays)
    assertEquals(6, result.committedUnits)
  }

  @Test
  fun `realistic typing lets line shortcuts convert and settle before continuing`() {
    for (marker in listOf("> ", "- ", "* ", "• ", "+ ", "12. ", "3) ")) {
      val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
      sink.readText = { _, call -> if (call == 1) marker else "" }
      var result: ImeCommitResult? = null
      driver(sink).commit(marker + "body", null) { result = it }
      sink.runUntil { sink.readSizes.size == 1 }
      assertEquals(marker, sink.committedChars.joinToString(""))
      assertEquals(40L, sink.delays.last())
      sink.step()
      assertEquals(marker, sink.committedChars.joinToString(""))
      assertEquals(150L, sink.delays.last())
      sink.step()
      assertTrue(result!!.success)
      assertEquals(marker + "body", sink.committedChars.joinToString(""))
    }
  }

  @Test
  fun `line start state resets at newline and survives inline segment boundaries`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> "converted" }
    assertTrue(commit(sink, "*bold*\n> body", null).success)
    assertEquals(1, sink.delays.count { it == 150L })
    assertEquals("*bold*\n> body", sink.committedChars.joinToString(""))
  }

  @Test
  fun `realistic typing lets a completed mention settle before the next formatted segment`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    assertTrue(commit(sink, "@person.name *bold*", null).success)
    assertEquals(listOf(45L, 45L, 400L, 45L), sink.delays)
    val terminal = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    assertTrue(commit(terminal, "@person ", null).success)
    assertEquals(listOf(45L), terminal.delays)
  }

  @Test
  fun `realistic typing pauses and mention and line conversion waits are excluded from the deadline`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.advanceClockOnDrain = true
    sink.readText = { _, _ -> "" }
    var result: ImeCommitResult? = null
    driver(sink).commit("> @person tail!", null, deadlineMs = 1L) { result = it }
    sink.drain()
    assertTrue(result!!.success)
    assertEquals(685L, sink.clockMs)
  }

  @Test
  fun `realistic typing waits for an unconverted line shortcut only to the bounded ceiling`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> null }
    assertTrue(commit(sink, "> body", null).success)
    assertEquals(12, sink.readSizes.size)
    assertEquals(11, sink.delays.count { it == 40L })
    assertEquals(150L, sink.delays.last())
  }

  @Test
  fun `line poll cancellation and deadline stop once without further typing`() {
    for (cancel in listOf(true, false)) {
      val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
      sink.readText = { _, _ -> "> " }
      var cancelled = false
      val results = mutableListOf<ImeCommitResult>()
      val driver = driver(sink)
      driver.commit("> body", PRIOR_IME_ID, deadlineMs = 1L, isCancelled = { cancelled }) {
        results.add(it)
      }
      sink.runUntil { sink.readSizes.isNotEmpty() }
      if (cancel) cancelled = true else sink.clockMs = sink.delays.sum() + 1L
      sink.drain()
      driver.cancel()
      assertEquals("> ", sink.committedChars.joinToString(""))
      assertEquals(1, results.size)
      assertEquals(
        if (cancel) "IME commit cancelled" else "IME commit deadline exceeded",
        results.single().error,
      )
      assertTrue(results.single().partialApplication)
      assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
    }
  }

  @Test
  fun `long word run does not recurse per grapheme`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    assertTrue(commit(sink, "a".repeat(20_000), null).success)
    assertEquals(20_000, sink.committedChars.size)
  }

  @Test
  fun `pure reconciliation distinguishes phase restart and visible prefix`() {
    val units = listOf("a", "b")
    for (postDispatch in listOf(false, true)) {
      assertEquals(
        ImeCommitDriver.Reconciliation.Resume(1),
        ImeCommitDriver.reconcileDecision(postDispatch, false, "", "a", units),
      )
      assertEquals(
        if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("")
        else ImeCommitDriver.Reconciliation.Fail(NONE_APPLIED_ERROR, ""),
        ImeCommitDriver.reconcileDecision(postDispatch, true, "", "", units),
      )
      assertEquals(
        if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("ab")
        else ImeCommitDriver.Reconciliation.Continue,
        ImeCommitDriver.reconcileDecision(postDispatch, false, "", "ab", units),
      )
    }
    for (restart in listOf(false, true)) {
      assertEquals(
        if (restart) ImeCommitDriver.Reconciliation.Continue
        else ImeCommitDriver.Reconciliation.Fail("Editor disconnected during IME commit", null),
        ImeCommitDriver.reconcileDecision(false, restart, null, null, units),
      )
      assertEquals(
        if (restart) ImeCommitDriver.Reconciliation.Continue
        else ImeCommitDriver.Reconciliation.Fail("Editor disconnected during IME commit", "AB"),
        ImeCommitDriver.reconcileDecision(false, restart, "", "AB", units),
      )
    }
    assertEquals(
      ImeCommitDriver.Reconciliation.Succeed(null),
      ImeCommitDriver.reconcileDecision(true, false, null, null, units),
    )
    assertEquals(
      ImeCommitDriver.Reconciliation.Succeed("AB"),
      ImeCommitDriver.reconcileDecision(true, false, "", "AB", units),
    )
  }

  @Test
  fun `pure reconciliation requires resume progress regardless of restart flag`() {
    val units = listOf("a", "b", "c", "d")
    for (postDispatch in listOf(false, true)) {
      for (restart in listOf(false, true)) {
        assertEquals(
          ImeCommitDriver.Reconciliation.Resume(2),
          ImeCommitDriver.reconcileDecision(postDispatch, restart, "", "ab", units, 1),
        )
        for (lastResume in listOf(2, 3)) {
          assertEquals(
            if (postDispatch) ImeCommitDriver.Reconciliation.Succeed("ab")
            else ImeCommitDriver.Reconciliation.Continue,
            ImeCommitDriver.reconcileDecision(
              postDispatch,
              restart,
              "",
              "ab",
              units,
              lastResume,
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
  fun `stripped final newline succeeds with retained query after one resend`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "hello\n", PRIOR_IME_ID)
    assertEquals(2, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("hello", result.insertedText)
  }

  @Test
  fun `stripped mid dispatch newline continues remaining line after one resend`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
    sink.afterCommit = {
      if (sink.committedChars.last() == "\n") {
        sink.editorText = requireNotNull(sink.editorText).dropLast(1)
        sink.generation++
      }
    }
    val result = commit(sink, "line one\nline two", PRIOR_IME_ID)
    assertEquals(2, sink.committedChars.count { it == "\n" })
    assertTrue(result.success)
    assertNull(result.error)
    assertEquals("line oneline two", result.insertedText)
  }

  @Test
  fun `consume on space fails without ever resending consumed units`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = ""
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
    assertEquals("ab ", sink.committedChars.joinToString(""))
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
        assertNull(commit(sink, "secret", PRIOR_IME_ID).insertedText)
        assertTrue(sink.editorReads > 0)
      }
    }
  }

  @Test
  fun `hard deadline caps excluded settle waits`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.advanceClockOnDrain = true
    var result: ImeCommitResult? = null
    driver(sink).commit("@person tail", PRIOR_IME_ID, deadlineMs = 1L, hardDeadlineMs = 100L) {
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
    driver(sink).commit("line one", PRIOR_IME_ID, hardDeadlineMs = 100L) { result = it }
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
    driver(sink).commit("hello", PRIOR_IME_ID, hardDeadlineMs = 100L) { result = it }
    assertEquals("IME commit deadline exceeded", result?.error)
    assertEquals(1, sink.syncCalls)
    assertEquals(1, sink.editorReads)
    assertEquals("hello", sink.editorText)
    assertEquals(listOf(PRIOR_IME_ID), sink.switchedImeIds)
  }

  private fun restartingSink(
    baseline: String,
    restart: Boolean,
    lostAt: Int = 0,
  ): FakeImeCommitSink {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.editorText = baseline
    sink.restarting = restart
    sink.beforeCommit = { index -> if (index == lostAt) sink.stale = true }
    sink.beforeContinuation = continuation@{
      if (!sink.stale) return@continuation
      if (!restart && sink.generation == 0L) {
        sink.generation = 1
        sink.identity = null
      } else {
        sink.generation = if (restart) 1 else 2
        sink.identity = "same-editor"
        sink.stale = false
      }
    }
    return sink
  }

  // The driver consumes supplied editing units. Android ICU segmentation has its own test suite;
  // the JVM's Unicode grapheme matcher supplies this fake without booting an Android runtime.
  private fun driver(sink: FakeImeCommitSink) =
    ImeCommitDriver(sink) { text -> Regex("\\X").findAll(text).map { it.value }.toList() }

  private fun commit(sink: FakeImeCommitSink, text: String, priorImeId: String?): ImeCommitResult {
    var result: ImeCommitResult? = null
    driver(sink).commit(text, priorImeId) { result = it }
    sink.drain()
    return requireNotNull(result)
  }

  private fun unicodeCorpus() =
    listOf(
      "a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️fé日本",
      "1️⃣",
      "e\u0301",
      "🏳️‍🌈",
      "👩🏽‍💻",
      "ไทย",
      "हिन्दी",
      "مرحبا",
      "한국어",
    )

  private fun String.hasWellFormedUtf16(): Boolean {
    var index = 0
    while (index < length) {
      when {
        this[index].isHighSurrogate() -> {
          if (index + 1 >= length || !this[index + 1].isLowSurrogate()) return false
          index += 2
        }
        this[index].isLowSurrogate() -> return false
        else -> index++
      }
    }
    return true
  }

  internal class FakeImeCommitSink(
    private val inputType: Int?,
    private val failAtCommitIndex: Int? = null,
    private val failSync: Boolean = false,
    // Fail only the first N barriers, as a connection re-bound after the last unit does.
    private val failSyncCalls: Int = 0,
  ) : ImeCommitSink {
    val committedChars = mutableListOf<String>()
    val sentKeyUnits = mutableListOf<String>()
    var supportedKeyUnits: (List<String>) -> Boolean = { true }
    var afterKeyUnit: (() -> Unit)? = null
    val switchedImeIds = mutableListOf<String>()
    val events = mutableListOf<String>()
    val delays = mutableListOf<Long>()
    val readSizes = mutableListOf<Int>()
    var generation = 0L
    var identity: String? = "same-editor"
    var restarting = true
    var editorText: String? = null
    var stale = false
    var beforeCommit: ((Int) -> Unit)? = null
    var beforeContinuation: (() -> Unit)? = null
    val appliedChars = mutableListOf<String>()

    override fun connectionGeneration(): Long = generation

    override fun editorIdentity(): String? = identity

    override fun startedByRestart(): Boolean = restarting

    override fun readEditorTextBeforeCursor(maxChars: Int): String? {
      editorReads++
      return if (stale) null else editorText?.takeLast(maxChars)
    }

    var readText: (Int, Int) -> String? = { _, _ -> null }
    var afterCommit: (() -> Unit)? = null
    var afterSync: (() -> Unit)? = null
    var editorReads = 0
    var syncCalls = 0
    var clockMs = 0L
    var advanceClockOnDrain = false
    private val pending = ArrayDeque<Pair<Long, () -> Unit>>()
    private var commitAttempts = 0

    override fun editorInputType(): Int? = inputType

    override fun nowMs(): Long = clockMs

    override fun commitChar(ch: CharSequence): Boolean {
      val currentAttempt = commitAttempts++
      beforeCommit?.invoke(currentAttempt)
      if (currentAttempt == failAtCommitIndex) return false
      committedChars.add(ch.toString())
      if (!stale && editorText != null) {
        editorText += ch.toString()
        appliedChars.add(ch.toString())
      }
      events.add("char")
      afterCommit?.invoke()
      return true
    }

    override fun supportsKeyEvents(units: List<String>): Boolean = supportedKeyUnits(units)

    override fun sendKeyEventUnit(unit: String): Boolean {
      sentKeyUnits.add(unit)
      afterKeyUnit?.invoke()
      return true
    }

    override fun finishComposing(): Boolean {
      events.add("finish")
      return true
    }

    override fun readTextBeforeCursor(maxChars: Int): String? {
      readSizes.add(maxChars)
      events.add("read")
      return readText(maxChars, readSizes.size)
    }

    override fun postDelayed(delayMs: Long, action: () -> Unit) {
      delays.add(delayMs)
      pending.addLast(delayMs to action)
    }

    fun step() {
      val (delay, action) = pending.removeFirst()
      if (advanceClockOnDrain) clockMs += delay
      beforeContinuation?.invoke()
      action()
    }

    fun runUntil(condition: () -> Boolean) {
      while (!condition()) {
        check(pending.isNotEmpty()) { "No scheduled continuation" }
        step()
      }
    }

    fun drain() {
      while (pending.isNotEmpty()) step()
    }

    override fun syncEditorState(): Boolean {
      syncCalls++
      afterSync?.invoke()
      if (failSync || syncCalls <= failSyncCalls) return false
      events.add("sync")
      return true
    }

    override fun switchToIme(imeId: String) {
      switchedImeIds.add(imeId)
      events.add("switch")
    }
  }

  companion object {
    private const val NONE_APPLIED_ERROR =
      "Editor restarted its input connection during IME commit; none of the dispatched text is in the editor"
    private const val PRIOR_IME_ID = "dev.example/.PreviousIme"
  }
}
