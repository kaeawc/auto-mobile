package dev.jasonpearson.automobile.ctrlproxy

import android.view.inputmethod.EditorInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme
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

  // ----- Which action id is sent (#10219 review): a submit word runs the EDITOR's action -----

  private fun options(action: Int, flags: Int = 0) = action or flags

  @Test
  fun `a submit word sends the editor's own configured action whatever word was asked`() {
    val declared =
      mapOf(
        "search" to EditorInfo.IME_ACTION_SEARCH,
        "go" to EditorInfo.IME_ACTION_GO,
        "send" to EditorInfo.IME_ACTION_SEND,
        "done" to EditorInfo.IME_ACTION_DONE,
      )
    for (word in declared.keys) {
      for ((fieldAction, id) in declared) {
        assertEquals(
          "caller '$word' on a field declaring '$fieldAction'",
          id,
          resolveEditorActionId(word, options(id)),
        )
      }
    }
  }

  @Test
  fun `done on a search field sends search not done`() {
    assertEquals(
      EditorInfo.IME_ACTION_SEARCH,
      resolveEditorActionId("done", options(EditorInfo.IME_ACTION_SEARCH)),
    )
  }

  @Test
  fun `an editor with no action or that keeps Enter for a newline has none to send`() {
    val noAction =
      listOf(
        options(EditorInfo.IME_ACTION_NONE),
        options(EditorInfo.IME_ACTION_UNSPECIFIED),
        // Flags on top of a real action: the field wants Enter for a newline.
        options(EditorInfo.IME_ACTION_DONE, EditorInfo.IME_FLAG_NO_ENTER_ACTION),
        options(EditorInfo.IME_ACTION_SEARCH, EditorInfo.IME_FLAG_NO_ENTER_ACTION),
        0,
      )
    for (word in listOf("done", "go", "send", "search")) {
      for (imeOptions in noAction) {
        assertNull("'$word' with imeOptions=$imeOptions", resolveEditorActionId(word, imeOptions))
      }
    }
  }

  @Test
  fun `unrelated imeOptions flags do not hide the declared action`() {
    val imeOptions =
      options(EditorInfo.IME_ACTION_SEARCH, EditorInfo.IME_FLAG_NO_EXTRACT_UI or 0x10000000)
    assertEquals(EditorInfo.IME_ACTION_SEARCH, resolveEditorActionId("done", imeOptions))
  }

  @Test
  fun `next and previous stay literal whatever the editor declares`() {
    for (imeOptions in
      listOf(
        options(EditorInfo.IME_ACTION_SEARCH),
        options(EditorInfo.IME_ACTION_NONE),
        options(EditorInfo.IME_ACTION_DONE, EditorInfo.IME_FLAG_NO_ENTER_ACTION),
      )) {
      assertEquals(EditorInfo.IME_ACTION_NEXT, resolveEditorActionId("next", imeOptions))
      assertEquals(EditorInfo.IME_ACTION_PREVIOUS, resolveEditorActionId("previous", imeOptions))
    }
  }

  @Test
  fun `an unknown word resolves to nothing`() {
    assertNull(resolveEditorActionId("unknown", options(EditorInfo.IME_ACTION_SEARCH)))
  }

  @Test
  fun `the sent action is named for the reply`() {
    assertEquals("search", imeEditorActionName(EditorInfo.IME_ACTION_SEARCH))
    assertEquals("go", imeEditorActionName(EditorInfo.IME_ACTION_GO))
    assertEquals("send", imeEditorActionName(EditorInfo.IME_ACTION_SEND))
    assertEquals("done", imeEditorActionName(EditorInfo.IME_ACTION_DONE))
    assertEquals("next", imeEditorActionName(EditorInfo.IME_ACTION_NEXT))
    assertEquals("previous", imeEditorActionName(EditorInfo.IME_ACTION_PREVIOUS))
    assertEquals("action-77", imeEditorActionName(77))
  }

  // ----- What the keyboard reported becomes a dispatch -----

  @Test
  fun `a handled editor action reports the id it sent`() {
    val dispatch =
      dispatchFromEditorOutcome(
        "done",
        CtrlProxyIme.EditorActionOutcome.Sent(EditorInfo.IME_ACTION_SEARCH, handled = true),
      )
    assertTrue(dispatch.dispatched)
    assertEquals("search", dispatch.editorAction)
    assertEquals(ImeActionMechanism.EDITOR_ACTION, dispatch.mechanism)
  }

  @Test
  fun `an editor that rejects the action is a retryable failure naming what was sent`() {
    val dispatch =
      dispatchFromEditorOutcome(
        "done",
        CtrlProxyIme.EditorActionOutcome.Sent(EditorInfo.IME_ACTION_SEARCH, handled = false),
      )
    assertFalse(dispatch.dispatched)
    assertFalse(dispatch.indeterminate)
    assertTrue(dispatch.error.orEmpty().contains("'search'"))
  }

  @Test
  fun `no editor action or no connection asks for the no-keyboard path`() {
    for (outcome in
      listOf(
        CtrlProxyIme.EditorActionOutcome.NoEditorAction,
        CtrlProxyIme.EditorActionOutcome.NoConnection,
      )) {
      val dispatch = dispatchFromEditorOutcome("done", outcome)
      assertTrue(dispatch.fallBack)
      assertFalse(dispatch.dispatched)
      assertNull(dispatch.error)
    }
  }

  @Test
  fun `a timed out wait is indeterminate`() {
    val dispatch = dispatchFromEditorOutcome("next", null)
    assertTrue(dispatch.indeterminate)
    assertFalse(dispatch.dispatched)
    assertTrue(dispatch.error.orEmpty().contains("indeterminate"))
  }

  // ----- Focus change polling -----

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

  private fun poll(clock: Clock, before: FocusIdentity?, reads: List<FocusRead>): FocusChange {
    val queue = ArrayDeque(reads)
    return awaitFocusChange(
      before,
      { if (queue.size > 1) queue.removeFirst() else queue.first() },
      { clock.now },
      clock::pause,
    )
  }

  @Test
  fun `focus that moved to another input is seen on the first read`() {
    val clock = Clock()
    assertEquals(FocusChange.MOVED, poll(clock, a, listOf(FocusRead.Input(b))))
    assertTrue(clock.pauses.isEmpty())
  }

  @Test
  fun `focus that moves after a delayed app handler is seen on a later poll`() {
    val clock = Clock()
    val reads = listOf(FocusRead.Input(a), FocusRead.Input(a), FocusRead.Input(b))
    assertEquals(FocusChange.MOVED, poll(clock, a, reads))
    assertEquals(listOf(FOCUS_MOVE_POLL_MS, FOCUS_MOVE_POLL_MS), clock.pauses)
  }

  @Test
  fun `focus that stays on the same input times out as unchanged`() {
    val clock = Clock()
    assertEquals(FocusChange.UNCHANGED, poll(clock, a, listOf(FocusRead.Input(a))))
    assertTrue(clock.now >= FOCUS_MOVE_TIMEOUT_MS)
  }

  @Test
  fun `focus that left the field entirely is the action taking effect not unchanged`() {
    // Next on the last field submitted and the next screen has no input focus.
    val clock = Clock()
    assertEquals(FocusChange.LEFT_FIELD, poll(clock, a, listOf(FocusRead.NoInput)))
    assertTrue(clock.pauses.isEmpty())
  }

  @Test
  fun `focus that leaves after the app handler ran is seen on a later poll`() {
    val clock = Clock()
    val reads = listOf(FocusRead.Input(a), FocusRead.NoInput)
    assertEquals(FocusChange.LEFT_FIELD, poll(clock, a, reads))
  }

  @Test
  fun `a window that cannot be read is reported separately and never counts as moved`() {
    val clock = Clock()
    assertEquals(FocusChange.UNREADABLE, poll(clock, a, listOf(FocusRead.Unreadable)))
    assertTrue(clock.now >= FOCUS_MOVE_TIMEOUT_MS)
  }

  @Test
  fun `an unreadable window that then shows another input counts as moved`() {
    val clock = Clock()
    assertEquals(
      FocusChange.MOVED,
      poll(clock, a, listOf(FocusRead.Unreadable, FocusRead.Input(b))),
    )
  }

  // ----- Verdicts -----

  @Test
  fun `a failed dispatch is a retryable failure carrying its reason`() {
    val verdict =
      judgeImeAction(
        "next",
        ImeActionMechanism.FOCUS_TRAVERSAL,
        ImeDispatch(false, "No next focusable node found"),
        focusChange = null,
      )
    assertFalse(verdict.success)
    assertEquals("No next focusable node found", verdict.error)
    assertTrue(verdict.retryable)
  }

  @Test
  fun `an indeterminate dispatch is not retryable`() {
    val verdict =
      judgeImeAction(
        "done",
        ImeActionMechanism.EDITOR_ACTION,
        ImeDispatch(false, "Timed out", indeterminate = true),
        focusChange = null,
      )
    assertFalse(verdict.success)
    assertFalse(verdict.retryable)
  }

  @Test
  fun `next that dispatched but left focus unchanged or unreadable is a non-retryable failure`() {
    for (mechanism in
      listOf(ImeActionMechanism.EDITOR_ACTION, ImeActionMechanism.FOCUS_TRAVERSAL)) {
      for (action in listOf("next", "previous")) {
        for (change in listOf(FocusChange.UNCHANGED, FocusChange.UNREADABLE, null)) {
          val verdict = judgeImeAction(action, mechanism, ImeDispatch(true), change)
          val label = "$action via $mechanism with $change"
          assertFalse(label, verdict.success)
          assertFalse(label, verdict.retryable)
          assertTrue(label, verdict.error.orEmpty().contains("indeterminate"))
          assertTrue(label, verdict.error.orEmpty().contains("Do not retry automatically"))
        }
      }
    }
  }

  @Test
  fun `the unchanged and unreadable failures say which it was`() {
    val unchanged =
      judgeImeAction(
        "next",
        ImeActionMechanism.EDITOR_ACTION,
        ImeDispatch(true),
        FocusChange.UNCHANGED,
      )
    val unreadable =
      judgeImeAction(
        "next",
        ImeActionMechanism.EDITOR_ACTION,
        ImeDispatch(true),
        FocusChange.UNREADABLE,
      )
    assertTrue(unchanged.error.orEmpty().contains("did not change"))
    assertTrue(unreadable.error.orEmpty().contains("could not be read"))
  }

  @Test
  fun `next that moved focus or left the field succeeds`() {
    for (change in listOf(FocusChange.MOVED, FocusChange.LEFT_FIELD)) {
      val verdict =
        judgeImeAction("next", ImeActionMechanism.EDITOR_ACTION, ImeDispatch(true), change)
      assertTrue("$change", verdict.success)
      assertNull(verdict.error)
      assertTrue(verdict.retryable)
    }
  }

  @Test
  fun `done go send and search succeed once the action was dispatched and report what was sent`() {
    for (action in listOf("done", "go", "send", "search")) {
      for (mechanism in ImeActionMechanism.entries) {
        val verdict =
          judgeImeAction(
            action,
            mechanism,
            ImeDispatch(true, editorAction = "search"),
            focusChange = null,
          )
        assertTrue(verdict.success)
        assertNull(verdict.error)
        assertEquals("search", verdict.editorAction)
        assertEquals(mechanism, verdict.mechanism)
      }
    }
  }

  @Test
  fun `the dispatch's own mechanism wins over the planned one after a fallback`() {
    val verdict =
      judgeImeAction(
        "done",
        ImeActionMechanism.IME_ENTER,
        ImeDispatch(true, mechanism = ImeActionMechanism.KEYCODE_ENTER),
        null,
      )
    assertEquals(ImeActionMechanism.KEYCODE_ENTER, verdict.mechanism)
  }

  @Test
  fun `a failed done dispatch falls back to the generic failure text`() {
    val verdict = judgeImeAction("done", ImeActionMechanism.IME_ENTER, ImeDispatch(false), null)
    assertFalse(verdict.success)
    assertEquals("Action failed", verdict.error)
    assertTrue(verdict.retryable)
  }
}
