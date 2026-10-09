package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

// These inputs model reported accessibility node states; they are unverified against a device.
class InsertTextPlannerTest {
  private class FakeTimer {
    var nowMs = 0L
    val pauses = mutableListOf<Long>()

    fun pause(ms: Long) {
      pauses.add(ms)
      nowMs += ms
    }
  }

  private class FakeNode(val states: List<InsertTextSnapshot>) {
    var reads = 0
    var current = states.first()
    val selectionTexts = mutableListOf<String?>()
    val selectionListed: Boolean
      get() = !current.text.isNullOrEmpty()

    fun refresh(): InsertTextSnapshot {
      current = states[minOf(reads++, states.lastIndex)]
      return current
    }

    fun setSelection(caret: Int): Boolean {
      selectionTexts.add(current.text)
      if (caret !in 0..current.text.orEmpty().length) return false
      current = current.copy(selectionStart = caret, selectionEnd = caret)
      return true
    }
  }

  private fun placeSelection(
    plan: InsertTextPlan,
    node: FakeNode,
    timer: FakeTimer,
    acceptsCaretNotPlaced: Boolean = true,
  ): InsertTextOutcome {
    val observed = awaitInsertTextMutation(plan, node::refresh, { timer.nowMs }, timer::pause)
    val attempted = observed != null && node.selectionListed
    val returned = attempted && node.setSelection(plan.caret)
    val placed = insertTextSelectionSucceeded(true, attempted, returned, plan, node.current)
    return insertTextOutcome(true, attempted, placed, null, acceptsCaretNotPlaced)
  }

  @Test
  fun `stale text converges before selection is attempted`() {
    val plan = planInsertText("abc", false, 3, 3, "def")
    val stale = InsertTextSnapshot("abc", false, 3, 3)
    val node = FakeNode(listOf(stale, stale, stale.copy(text = "abcdef")))
    val timer = FakeTimer()
    assertEquals(
      InsertTextOutcome(true, null, null, null, false),
      placeSelection(plan, node, timer),
    )
    assertEquals(listOf("abcdef"), node.selectionTexts)
    assertEquals(listOf(25L, 25L), timer.pauses)
    assertEquals(3, node.reads)
  }

  @Test
  fun `never converged text preserves warning and legacy failure within bound`() {
    val plan = planInsertText("abc", false, 3, 3, "def")
    for (acceptsCaretNotPlaced in listOf(false, true)) {
      val node = FakeNode(listOf(InsertTextSnapshot("abc", false, 3, 3)))
      val timer = FakeTimer()
      assertEquals(
        insertTextOutcome(true, true, false, null, acceptsCaretNotPlaced),
        placeSelection(plan, node, timer, acceptsCaretNotPlaced),
      )
      assertEquals(200L, timer.nowMs)
      assertEquals(9, node.reads)
      assertEquals(listOf("abc"), node.selectionTexts)
    }
  }

  @Test
  fun `empty Compose field exposes selection action only after convergence`() {
    val plan = planInsertText("", false, -1, -1, "abc")
    val node =
      FakeNode(
        listOf(InsertTextSnapshot("", false, -1, -1), InsertTextSnapshot("abc", false, -1, -1)),
      )
    val timer = FakeTimer()
    assertEquals(false, node.selectionListed)
    assertEquals(
      InsertTextOutcome(true, null, null, null, false),
      placeSelection(plan, node, timer),
    )
    assertEquals(listOf("abc"), node.selectionTexts)
    assertEquals(listOf(25L), timer.pauses)
  }

  @Test
  fun `empty node never converges and preserves unattempted selection warning`() {
    val plan = planInsertText("", false, -1, -1, "abc")
    val node = FakeNode(listOf(InsertTextSnapshot("", false, -1, -1)))
    val timer = FakeTimer()
    assertEquals(
      insertTextOutcome(true, false, false, null, true),
      placeSelection(plan, node, timer),
    )
    assertEquals(200L, timer.nowMs)
    assertEquals(emptyList<String?>(), node.selectionTexts)
  }

  @Test
  fun `immediately converged node does not pause or refresh again`() {
    val plan = InsertTextPlan("abc", 3, true)
    val node = FakeNode(listOf(InsertTextSnapshot("abc", false, 3, 3)))
    val timer = FakeTimer()
    assertEquals(
      InsertTextOutcome(true, null, null, null, false),
      placeSelection(plan, node, timer),
    )
    assertEquals(1, node.reads)
    assertEquals(emptyList<Long>(), timer.pauses)
  }

  @Test
  fun `converged already correct caret accepts rejected selection`() {
    val plan = InsertTextPlan("abcdef", 6, false)
    val timer = FakeTimer()
    var reads = 0
    val observed =
      awaitInsertTextMutation(
        plan,
        {
          if (++reads == 1) InsertTextSnapshot("abc", false, 3, 3)
          else InsertTextSnapshot("abcdef", false, 6, 6)
        },
        { timer.nowMs },
        timer::pause,
      )
    assertEquals(true, insertTextSelectionSucceeded(true, true, false, plan, observed))
    assertEquals(2, reads)
    assertEquals(listOf(25L), timer.pauses)
  }

  @Test
  fun `node lost during mutation polling stops without moving selection`() {
    val timer = FakeTimer()
    var reads = 0
    assertEquals(
      null,
      awaitInsertTextMutation(
        InsertTextPlan("abc", 3, true),
        { if (++reads == 1) InsertTextSnapshot("", false, -1, -1) else null },
        { timer.nowMs },
        timer::pause,
      ),
    )
    assertEquals(2, reads)
    assertEquals(listOf(25L), timer.pauses)
  }

  @Test
  fun `convergence decision requires actual matching text and stops at deadline`() {
    val plan = InsertTextPlan("abc", 3, true)
    val converged = InsertTextSnapshot("abc", false, -1, -1)
    assertEquals(false, shouldPollInsertTextMutation(plan, converged, 0L))
    assertEquals(false, shouldPollInsertTextMutation(plan, converged, 200L))
    assertEquals(true, shouldPollInsertTextMutation(plan, converged.copy(text = "ab"), 199L))
    assertEquals(false, shouldPollInsertTextMutation(plan, converged.copy(text = "ab"), 200L))
    assertEquals(
      true,
      shouldPollInsertTextMutation(plan, converged.copy(isShowingHintText = true), 0L),
    )
    assertEquals(true, shouldPollInsertTextMutation(plan, converged.copy(text = null), 0L))
    assertEquals(false, shouldPollInsertTextMutation(plan, null, 0L))
  }

  @Test
  fun `refresh time counts toward deadline and final pause is clamped`() {
    val plan = InsertTextPlan("abc", 3, true)
    val stale = InsertTextSnapshot("", false, -1, -1)
    val timer = FakeTimer()
    var reads = 0
    assertEquals(
      stale,
      awaitInsertTextMutation(
        plan,
        {
          if (++reads == 1) timer.nowMs += 190L
          stale
        },
        { timer.nowMs },
        timer::pause,
      ),
    )
    assertEquals(listOf(10L), timer.pauses)
    assertEquals(200L, timer.nowMs)
    assertEquals(2, reads)
  }

  @Test
  fun `text converging on final deadline refresh is accepted`() {
    val plan = InsertTextPlan("abc", 3, true)
    val node =
      FakeNode(
        List(8) { InsertTextSnapshot("", false, -1, -1) } +
          InsertTextSnapshot("abc", false, -1, -1),
      )
    val timer = FakeTimer()
    assertEquals(
      InsertTextOutcome(true, null, null, null, false),
      placeSelection(plan, node, timer),
    )
    assertEquals(200L, timer.nowMs)
    assertEquals(listOf("abc"), node.selectionTexts)
  }

  @Test
  fun `false selection return with observed planned caret succeeds in both modes`() {
    val plan = InsertTextPlan("hello world", 11, false)
    val placed =
      insertTextSelectionSucceeded(
        true,
        true,
        false,
        plan,
        InsertTextSnapshot(plan.updatedText, false, 11, 11),
      )
    for (acceptsCaretNotPlaced in listOf(false, true)) {
      assertEquals(
        InsertTextOutcome(true, null, null, null, false),
        insertTextOutcome(true, true, placed, null, acceptsCaretNotPlaced),
      )
    }
  }

  @Test
  fun `false selection return with different caret preserves failure and warning`() {
    val plan = InsertTextPlan("hello world", 11, false)
    for ((start, end) in listOf(0 to 0, 11 to 0, 0 to 11, -1 to -1)) {
      val placed =
        insertTextSelectionSucceeded(
          true,
          true,
          false,
          plan,
          InsertTextSnapshot(plan.updatedText, false, start, end),
        )
      assertEquals(false, placed)
      for (acceptsCaretNotPlaced in listOf(false, true)) {
        assertEquals(
          insertTextOutcome(true, true, false, null, acceptsCaretNotPlaced),
          insertTextOutcome(true, true, placed, null, acceptsCaretNotPlaced),
        )
      }
    }
  }

  @Test
  fun `false selection return requires matching text and a refreshed snapshot`() {
    val plan = InsertTextPlan("hello world", 11, false)
    for (observed in listOf(null, InsertTextSnapshot("other text", false, 11, 11))) {
      assertEquals(false, insertTextSelectionSucceeded(true, true, false, plan, observed))
    }
  }

  @Test
  fun `true selection return preserves success without observed caret`() {
    val plan = InsertTextPlan("hello world", 11, false)
    val placed = insertTextSelectionSucceeded(true, true, true, plan, null)
    assertEquals(true, placed)
    for (acceptsCaretNotPlaced in listOf(false, true)) {
      assertEquals(
        InsertTextOutcome(true, null, "preceding warning", null, false),
        insertTextOutcome(true, true, placed, "preceding warning", acceptsCaretNotPlaced),
      )
    }
  }

  @Test
  fun `no selection action preserves observed offset rule and set text failure`() {
    val plan = InsertTextPlan("hello world", 11, false)
    val observed = InsertTextSnapshot("stale text", false, 11, 11)
    assertEquals(true, insertTextSelectionSucceeded(true, false, false, plan, observed))
    assertEquals(false, insertTextSelectionSucceeded(false, false, false, plan, observed))
    assertEquals(false, insertTextSelectionSucceeded(false, true, true, plan, observed))
  }

  @Test
  fun `unreported selection in empty field inserts at zero`() {
    assertEquals(
      InsertTextPlan("abc", 3, true),
      planInsertText("", false, -1, -1, "abc"),
    )
  }

  @Test
  fun `hint text is excluded with unreported selection`() {
    assertEquals(
      InsertTextPlan("abc", 3, true),
      planInsertText("Email", true, -1, -1, "abc"),
    )
  }

  @Test
  fun `unreported selection in nonempty field appends`() {
    assertEquals(
      InsertTextPlan("before!", 7, true),
      planInsertText("before", false, -1, -1, "!"),
    )
  }

  @Test
  fun `valid collapsed selection inserts in middle`() {
    assertEquals(
      InsertTextPlan("abXcd", 3, false),
      planInsertText("abcd", false, 2, 2, "X"),
    )
  }

  @Test
  fun `valid range replaces selected text`() {
    assertEquals(
      InsertTextPlan("aXd", 2, false),
      planInsertText("abcd", false, 1, 3, "X"),
    )
  }

  @Test
  fun `reversed selection replaces selected text`() {
    assertEquals(
      InsertTextPlan("hXo", 2, false),
      planInsertText("hello", false, 4, 1, "X"),
    )
  }

  @Test
  fun `end beyond text length appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, 1, 5, "X"),
    )
  }

  @Test
  fun `unreported start with valid end appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, -1, 2, "X"),
    )
  }

  @Test
  fun `valid start with unreported end appends`() {
    assertEquals(
      InsertTextPlan("abcdX", 5, true),
      planInsertText("abcd", false, 2, -1, "X"),
    )
  }

  @Test
  fun `valid selection in hint field uses empty text`() {
    assertEquals(
      InsertTextPlan("X", 1, false),
      planInsertText("Email", true, 0, 0, "X"),
    )
  }

  @Test
  fun `caret counts full UTF16 length of inserted graphemes`() {
    val insertions =
      listOf(
        "\uD83D\uDC4D\uD83C\uDFFD",
        "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67",
        "\uD83C\uDDEF\uD83C\uDDF5",
        "\u00E9",
        "e\u0301",
      )

    for (insertion in insertions) {
      assertEquals(
        InsertTextPlan("a${insertion}b", 1 + insertion.length, false),
        planInsertText("ab", false, 1, 1, insertion),
      )
      assertEquals(
        InsertTextPlan("ab$insertion", 2 + insertion.length, true),
        planInsertText("ab", false, -1, -1, insertion),
      )
    }
  }

  @Test
  fun `remembered caret is used when text matches and selection is unreported`() {
    assertEquals(
      InsertTextPlan("hel🇯🇵Xlo", 8, false, true),
      planInsertText("hel🇯🇵lo", false, -1, -1, "X", RememberedCaret("hel🇯🇵lo", 7, -1, -1)),
    )
    // UTF-16 offset 5 is between the flag's two regional indicators, not after the flag.
    assertEquals(
      InsertTextPlan("hel🇯X🇵lo", 6, false, true),
      planInsertText("hel🇯🇵lo", false, -1, -1, "X", RememberedCaret("hel🇯🇵lo", 5, -1, -1)),
    )
  }

  @Test
  fun `remembered caret wins over a valid reported selection when text matches`() {
    assertEquals(
      InsertTextPlan("abXcd", 3, false, true),
      planInsertText("abcd", false, 4, 4, "X", RememberedCaret("abcd", 2, 4, 4)),
    )
  }

  @Test
  fun `remembered caret is discarded when node text differs`() {
    val remembered = RememberedCaret("abcd", 2, 4, 4)
    assertEquals(
      InsertTextPlan("abcdeX", 6, true),
      planInsertText("abcde", false, -1, -1, "X", remembered),
    )
    assertEquals(
      InsertTextPlan("aXbcde", 2, false),
      planInsertText("abcde", false, 1, 1, "X", remembered),
    )
  }

  @Test
  fun `remembered caret out of range is ignored`() {
    assertEquals(
      InsertTextPlan("abX", 3, true),
      planInsertText("ab", false, -1, -1, "X", RememberedCaret("ab", 9, -1, -1)),
    )
  }

  @Test
  fun `caret moved to end uses reported selection instead of remembered offset seven`() {
    assertEquals(
      InsertTextPlan("hel🇯🇵loé", 10, false),
      planInsertText("hel🇯🇵lo", false, 9, 9, "é", RememberedCaret("hel🇯🇵lo", 7, -1, -1)),
    )
  }

  @Test
  fun `either reported selection endpoint changing invalidates remembered caret`() {
    val remembered = RememberedCaret("abcd", 2, 4, 4)
    assertEquals(
      InsertTextPlan("aXd", 2, false),
      planInsertText("abcd", false, 1, 3, "X", remembered),
    )
    assertEquals(
      InsertTextPlan("abcX", 4, false),
      planInsertText("abcd", false, 4, 3, "X", remembered),
    )
  }

  @Test
  fun `null remembered keeps today's behaviour`() {
    assertEquals(InsertTextPlan("abXcd", 3, false), planInsertText("abcd", false, 2, 2, "X", null))
    assertEquals(InsertTextPlan("abc", 3, true), planInsertText("Email", true, -1, -1, "abc", null))
  }
}
