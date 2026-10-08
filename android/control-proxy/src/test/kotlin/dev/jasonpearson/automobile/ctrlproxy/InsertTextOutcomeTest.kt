package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.*
import org.junit.Test

class InsertTextOutcomeTest {
  @Test
  fun `set selection false on valid-selection path is success with warning`() {
    val outcome = insertTextOutcome(true, true, false, null, true)
    assertTrue(outcome.success)
    assertNull(outcome.error)
    assertEquals(false, outcome.caretPlaced)
    assertFalse(outcome.partialApplication)
    assertTrue(outcome.warning.orEmpty().contains("caret could not be placed"))
  }

  @Test
  fun `set selection false on fallback path is success with warning`() {
    val plan = planInsertText("", false, -1, -1, "X")
    fun outcomeForNode(advertisesSelection: Boolean): InsertTextOutcome {
      val setTextSucceeded = true
      val selectionAttempted = setTextSucceeded && advertisesSelection
      val selectionSucceeded =
        if (selectionAttempted) false else plan.usedFallbackCaret && setTextSucceeded
      return insertTextOutcome(setTextSucceeded, selectionAttempted, selectionSucceeded, null, true)
    }
    assertEquals(insertTextOutcome(true, true, false, null, true), outcomeForNode(true))
  }

  @Test
  fun `set text false retains prior warnings`() {
    assertEquals(
      InsertTextOutcome(false, "ACTION_SET_TEXT returned false", "preceding warning", null, false),
      insertTextOutcome(false, false, false, "preceding warning"),
    )
  }

  @Test
  fun `unattempted placement with a confirmed reported caret is success without caretPlaced`() {
    assertEquals(
      InsertTextOutcome(true, null, null, null, false),
      insertTextOutcome(true, false, true, null),
    )
  }

  @Test
  fun `extra preceding-input warning is appended`() {
    val warning = "Preceding input was not observed"
    assertTrue(
      insertTextOutcome(true, true, false, warning, true).warning.orEmpty().endsWith(" " + warning),
    )
    assertEquals(warning, insertTextOutcome(true, true, true, warning).warning)
  }

  @Test
  fun `old daemon retains failure and partial application on failed placement`() {
    assertEquals(
      InsertTextOutcome(
        false,
        "Text was inserted, but ACTION_SET_SELECTION returned false; do not retry",
        null,
        null,
        true,
      ),
      insertTextOutcome(true, true, false, null),
    )
    assertTrue(insertTextOutcome(true, true, false, "earlier warning").partialApplication)
    assertEquals("earlier warning", insertTextOutcome(true, true, false, "earlier warning").warning)
  }

  @Test
  fun `unattempted unknown placement warns new clients and fails legacy clients`() {
    assertFalse(insertTextOutcome(true, false, false, null).success)
    assertEquals(false, insertTextOutcome(true, false, false, null, true).caretPlaced)
  }

  @Test
  fun `nextRememberedCaret returns plan text and caret only for success with caretPlaced false`() {
    val plan = InsertTextPlan("abXcd", 3, false)
    assertEquals(
      RememberedCaret("abXcd", 3, -1, -1),
      nextRememberedCaret(insertTextOutcome(true, true, false, null, true), plan, -1, -1),
    )
    assertNull(nextRememberedCaret(insertTextOutcome(true, true, true, null), plan, -1, -1))
    assertNull(nextRememberedCaret(insertTextOutcome(false, false, false, null), plan, -1, -1))
    assertNull(nextRememberedCaret(insertTextOutcome(true, false, true, null), plan, -1, -1))
  }
}
