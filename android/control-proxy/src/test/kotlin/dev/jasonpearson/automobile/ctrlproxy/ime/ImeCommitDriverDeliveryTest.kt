package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverDeliveryTest : ImeCommitDriverFixtures() {
  @Test
  fun `key event delivery sends units without committing text`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    var result: ImeCommitResult? = null
    driver(sink).commit(
      ImeCommitRequest("Ab!", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS),
    ) {
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
    driver(sink).commit(
      ImeCommitRequest("a😀", PRIOR_IME_ID, delivery = ImeTextDelivery.KEY_EVENTS),
    ) {
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
      ImeCommitRequest(
        "ab",
        PRIOR_IME_ID,
        isCancelled = { cancelled },
        delivery = ImeTextDelivery.KEY_EVENTS,
      ),
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
    assertFalse(result.editorConsumed)
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

    driver(sink).commit(ImeCommitRequest("😀after", PRIOR_IME_ID, isCancelled = { cancelled })) {
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

    driver(sink).commit(ImeCommitRequest("👩‍👩‍👧‍👦next", PRIOR_IME_ID), deadlineMs = 10L) {
      result = it
    }

    sink.drain()
    assertEquals(listOf("👩‍👩‍👧‍👦"), sink.committedChars)
    assertEquals("IME commit deadline exceeded", result?.error)
    assertTrue(result!!.partialApplication)
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
}
