package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

// These inputs model reported accessibility node states; they are unverified against a device.
class InsertTextPlannerTest {
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
