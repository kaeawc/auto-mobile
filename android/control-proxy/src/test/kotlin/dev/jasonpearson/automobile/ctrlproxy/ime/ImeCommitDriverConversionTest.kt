package dev.jasonpearson.automobile.ctrlproxy.ime

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ImeCommitDriverConversionTest : ImeCommitDriverFixtures() {
  @Test
  fun `multi-span commit waits for conversion before typing next span`() {
    val sink = FakeImeCommitSink(inputType = InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, call -> if (call <= 2) "`a`" else "abc" }
    var result: ImeCommitResult? = null

    driver(sink).commit(ImeCommitRequest("`a` `b`", PRIOR_IME_ID)) {
      result = it
    }

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

    driver(sink).commit(ImeCommitRequest("`abc``b`", PRIOR_IME_ID)) {
      result = it
    }

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

    driver(sink).commit(ImeCommitRequest("`abc``b`", PRIOR_IME_ID)) {
      result = it
    }

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
      ImeCommitRequest("`a``b``c``d``e``f``g``h``i` tail", PRIOR_IME_ID),
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

      driver(sink).commit(ImeCommitRequest("$span tail", PRIOR_IME_ID)) {
        result = it
      }

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
  fun `realistic typing yields at non-word graphemes while letter and digit runs stay synchronous`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("a1é!😀b", null)) {
      result = it
    }
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
      driver(sink).commit(ImeCommitRequest(marker + "body", null)) {
        result = it
      }
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
    assertTrue(
      commit(sink, "*bold*\n> body", null).success,
    )
    assertEquals(1, sink.delays.count { it == 150L })
    assertEquals("*bold*\n> body", sink.committedChars.joinToString(""))
  }

  @Test
  fun `realistic typing lets a completed mention settle before the next formatted segment`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    assertTrue(
      commit(sink, "@person.name *bold*", null).success,
    )
    assertEquals(listOf(45L, 45L, 400L, 45L), sink.delays)
    val terminal = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    assertTrue(
      commit(terminal, "@person ", null).success,
    )
    assertEquals(listOf(45L), terminal.delays)
  }

  @Test
  fun `realistic typing pauses and mention and line conversion waits are excluded from the deadline`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.advanceClockOnDrain = true
    sink.readText = { _, _ -> "" }
    var result: ImeCommitResult? = null
    driver(sink).commit(ImeCommitRequest("> @person tail!", null), deadlineMs = 1L) {
      result = it
    }
    sink.drain()
    assertTrue(result!!.success)
    assertEquals(685L, sink.clockMs)
  }

  @Test
  fun `realistic typing waits for an unconverted line shortcut only to the bounded ceiling`() {
    val sink = FakeImeCommitSink(InputType.TYPE_CLASS_TEXT)
    sink.readText = { _, _ -> null }
    assertTrue(
      commit(sink, "> body", null).success,
    )
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
      driver.commit(
        ImeCommitRequest("> body", PRIOR_IME_ID, isCancelled = { cancelled }),
        deadlineMs = 1L,
      ) {
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
    assertTrue(
      commit(sink, "a".repeat(20_000), null).success,
    )
    assertEquals(20_000, sink.committedChars.size)
  }
}
