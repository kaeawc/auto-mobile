package dev.jasonpearson.automobile.ctrlproxy

import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Issue #10219: candidate filtering, the focus-moved check and the reply verdict. */
class ImeActionPlanningTest {
  private fun row(
    current: Boolean = false,
    editable: Boolean = true,
    focusable: Boolean = true,
    visible: Boolean = true,
    enabled: Boolean = true,
  ) = FocusCandidate(current, editable, focusable, visible, enabled)

  @Test
  fun `next skips a disabled field between two enabled ones`() {
    // Email, a disabled Referral code, Password: the keyboard's Next lands on Password.
    val rows = listOf(row(current = true), row(enabled = false), row())
    assertEquals(2, selectAdjacentCandidate(rows, forward = true))
  }

  @Test
  fun `previous skips an invisible field between two visible ones`() {
    val rows = listOf(row(), row(visible = false), row(current = true))
    assertEquals(0, selectAdjacentCandidate(rows, forward = false))
  }

  @Test
  fun `candidate filter table`() {
    data class Case(val name: String, val target: FocusCandidate, val expected: Int?)
    val cases =
      listOf(
        Case("eligible", row(), 1),
        Case("disabled", row(enabled = false), null),
        Case("not visible", row(visible = false), null),
        Case("not focusable", row(focusable = false), null),
        Case("not editable", row(editable = false), null),
      )
    for (case in cases) {
      val rows = listOf(row(current = true), case.target)
      assertEquals(case.name, case.expected, selectAdjacentCandidate(rows, forward = true))
    }
  }

  @Test
  fun `the current row is a position even when it is not itself eligible`() {
    val rows = listOf(row(current = true, visible = false), row())
    assertEquals(1, selectAdjacentCandidate(rows, forward = true))
  }

  @Test
  fun `no current row or no eligible neighbour selects nothing`() {
    assertNull(selectAdjacentCandidate(listOf(row(), row()), forward = true))
    assertNull(selectAdjacentCandidate(listOf(row(), row(current = true)), forward = true))
    assertNull(selectAdjacentCandidate(listOf(row(current = true), row()), forward = false))
    assertNull(selectAdjacentCandidate(emptyList(), forward = true))
  }

  @Test
  fun `the action names map to the framework editor action ids`() {
    assertEquals(EditorInfo.IME_ACTION_NEXT, imeEditorActionId("next"))
    assertEquals(EditorInfo.IME_ACTION_PREVIOUS, imeEditorActionId("previous"))
    assertEquals(EditorInfo.IME_ACTION_DONE, imeEditorActionId("done"))
    assertEquals(EditorInfo.IME_ACTION_GO, imeEditorActionId("go"))
    assertEquals(EditorInfo.IME_ACTION_SEND, imeEditorActionId("send"))
    assertEquals(EditorInfo.IME_ACTION_SEARCH, imeEditorActionId("search"))
    assertNull(imeEditorActionId("unknown"))
  }

  private val a = FocusIdentity(1, "email")
  private val b = FocusIdentity(2, "password")

  private class Clock {
    var now = 0L
    val pauses = mutableListOf<Long>()

    fun pause(ms: Long) {
      pauses += ms
      now += ms
    }
  }

  @Test
  fun `focus that moved to another input is seen on the first read`() {
    val clock = Clock()
    assertTrue(awaitFocusMoved(a, { b }, { clock.now }, clock::pause))
    assertTrue(clock.pauses.isEmpty())
  }

  @Test
  fun `focus that moves after a delayed app handler is seen on a later poll`() {
    val clock = Clock()
    val reads = ArrayDeque(listOf(a, a, b))
    assertTrue(awaitFocusMoved(a, { reads.removeFirst() }, { clock.now }, clock::pause))
    assertEquals(listOf(FOCUS_MOVE_POLL_MS, FOCUS_MOVE_POLL_MS), clock.pauses)
  }

  @Test
  fun `focus that stays on the same input times out`() {
    val clock = Clock()
    assertFalse(awaitFocusMoved(a, { a }, { clock.now }, clock::pause))
    assertTrue(clock.now >= FOCUS_MOVE_TIMEOUT_MS)
  }

  @Test
  fun `an unreadable focus never counts as moved`() {
    val clock = Clock()
    assertFalse(awaitFocusMoved(a, { null }, { clock.now }, clock::pause))
  }

  @Test
  fun `a failed dispatch is a failure carrying its reason`() {
    val verdict =
      judgeImeAction(
        "next",
        ImeActionMechanism.FOCUS_TRAVERSAL,
        ImeDispatch(false, "No next focusable node found"),
        focusMoved = null,
      )
    assertEquals(ImeActionVerdict(false, "No next focusable node found"), verdict)
  }

  @Test
  fun `next that dispatched but did not move focus is never a success`() {
    for (mechanism in
      listOf(ImeActionMechanism.EDITOR_ACTION, ImeActionMechanism.FOCUS_TRAVERSAL)) {
      for (action in listOf("next", "previous")) {
        val verdict = judgeImeAction(action, mechanism, ImeDispatch(true), focusMoved = false)
        assertFalse("$action via $mechanism", verdict.success)
        assertTrue(verdict.error.orEmpty().contains("did not change"))
      }
    }
  }

  @Test
  fun `next that dispatched and moved focus succeeds`() {
    val verdict =
      judgeImeAction("next", ImeActionMechanism.EDITOR_ACTION, ImeDispatch(true), focusMoved = true)
    assertEquals(ImeActionVerdict(true, null), verdict)
  }

  @Test
  fun `next with no focus verification is not a success`() {
    assertFalse(
      judgeImeAction("next", ImeActionMechanism.EDITOR_ACTION, ImeDispatch(true), null).success
    )
  }

  @Test
  fun `done go send and search succeed once the action was dispatched`() {
    for (action in listOf("done", "go", "send", "search")) {
      for (mechanism in ImeActionMechanism.entries) {
        assertEquals(
          ImeActionVerdict(true, null),
          judgeImeAction(action, mechanism, ImeDispatch(true), focusMoved = null),
        )
      }
    }
  }

  @Test
  fun `a failed done dispatch falls back to the generic failure text`() {
    assertEquals(
      ImeActionVerdict(false, "Action failed"),
      judgeImeAction("done", ImeActionMechanism.IME_ENTER, ImeDispatch(false), null),
    )
  }
}
