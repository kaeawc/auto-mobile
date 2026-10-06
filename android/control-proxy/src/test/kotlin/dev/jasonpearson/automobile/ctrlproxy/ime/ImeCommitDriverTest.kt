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
  fun `text password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
  }

  @Test
  fun `visible text password field is refused and prior IME is restored`() {
    assertPasswordRefused(
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    )
  }

  @Test
  fun `web password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
  }

  @Test
  fun `number password field is refused and prior IME is restored`() {
    assertPasswordRefused(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
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

  private fun assertPasswordRefused(inputType: Int) {
    val sink = FakeImeCommitSink(inputType = inputType)

    val result = commit(sink, "secret", PRIOR_IME_ID)

    assertFalse(result.success)
    assertEquals("Cannot commit text into a password field", result.error)
    assertTrue(sink.committedChars.isEmpty())
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

  private class FakeImeCommitSink(
    private val inputType: Int?,
    private val failAtCommitIndex: Int? = null,
    private val failSync: Boolean = false,
  ) : ImeCommitSink {
    val committedChars = mutableListOf<String>()
    val sentKeyUnits = mutableListOf<String>()
    var supportedKeyUnits: (List<String>) -> Boolean = { true }
    var afterKeyUnit: (() -> Unit)? = null
    val switchedImeIds = mutableListOf<String>()
    val events = mutableListOf<String>()
    val delays = mutableListOf<Long>()
    val readSizes = mutableListOf<Int>()
    var readText: (Int, Int) -> String? = { _, _ -> null }
    var afterCommit: (() -> Unit)? = null
    var syncCalls = 0
    var clockMs = 0L
    var advanceClockOnDrain = false
    private val pending = ArrayDeque<Pair<Long, () -> Unit>>()
    private var commitAttempts = 0

    override fun editorInputType(): Int? = inputType

    override fun nowMs(): Long = clockMs

    override fun commitChar(ch: CharSequence): Boolean {
      val currentAttempt = commitAttempts++
      if (currentAttempt == failAtCommitIndex) return false
      committedChars.add(ch.toString())
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
      if (failSync) return false
      events.add("sync")
      return true
    }

    override fun switchToIme(imeId: String) {
      switchedImeIds.add(imeId)
      events.add("switch")
    }
  }

  companion object {
    private const val PRIOR_IME_ID = "dev.example/.PreviousIme"
  }
}
