package dev.jasonpearson.automobile.ctrlproxy

import android.view.inputmethod.EditorInfo

/**
 * How an IME action was actually delivered. Reported on `ime_action_result` as `mechanism`
 * (additive; absent when the request failed before any delivery was attempted) so a caller can tell
 * the keyboard's own action key (`editor-action`) from an approximation (`focus-traversal`).
 */
internal enum class ImeActionMechanism(val wire: String) {
  /** `InputConnection.performEditorAction`: the app's own editor-action handler runs. */
  EDITOR_ACTION("editor-action"),
  /** The service moved accessibility focus itself; the field's Next/Previous handler never ran. */
  FOCUS_TRAVERSAL("focus-traversal"),
  /** `ACTION_IME_ENTER` on the focused node (API 30+). */
  IME_ENTER("ime-enter"),
  /** `input keyevent 66` (pre-API 30). */
  KEYCODE_ENTER("keycode-enter"),
}

/** The `EditorInfo.IME_ACTION_*` id for a wire action name, or null for an unknown action. */
internal fun imeEditorActionId(action: String): Int? =
  when (action) {
    "next" -> EditorInfo.IME_ACTION_NEXT
    "previous" -> EditorInfo.IME_ACTION_PREVIOUS
    "done" -> EditorInfo.IME_ACTION_DONE
    "go" -> EditorInfo.IME_ACTION_GO
    "send" -> EditorInfo.IME_ACTION_SEND
    "search" -> EditorInfo.IME_ACTION_SEARCH
    else -> null
  }

/** Next/previous are judged by whether the focused input changed, not by the dispatch alone. */
internal fun isFocusMovingImeAction(action: String): Boolean =
  action == "next" || action == "previous"

/**
 * A node the focus traversal fallback may move focus to: the user must be able to see it, it must
 * accept input and it must take focus. A real Next key skips anything else, so the fallback must
 * too (a disabled field refuses `ACTION_FOCUS`, an invisible one is not a target the user could
 * reach).
 */
internal fun isReachableFocusTarget(
  focusable: Boolean,
  visibleToUser: Boolean,
  enabled: Boolean,
): Boolean = focusable && visibleToUser && enabled

/**
 * One editable node in tree order, reduced to the facts the candidate filter needs. [isCurrent]
 * marks the node focus is moving away from; it is located before filtering because the current node
 * is a position, not a target.
 */
internal data class FocusCandidate(
  val isCurrent: Boolean,
  val editable: Boolean,
  val focusable: Boolean,
  val visibleToUser: Boolean,
  val enabled: Boolean,
) {
  val eligible: Boolean
    get() = editable && isReachableFocusTarget(focusable, visibleToUser, enabled)
}

/**
 * The index of the nearest eligible candidate after ([forward]) or before the current one in tree
 * order, skipping disabled, invisible, non-focusable and non-editable rows. Null when there is no
 * current row or no eligible row in that direction.
 */
internal fun selectAdjacentCandidate(candidates: List<FocusCandidate>, forward: Boolean): Int? {
  val current = candidates.indexOfFirst { it.isCurrent }
  if (current < 0) return null
  val range = if (forward) (current + 1)..candidates.lastIndex else (current - 1) downTo 0
  return range.firstOrNull { candidates[it].eligible }
}

/**
 * Which input had focus, compared across two reads. [nodeHash] is the framework's node hash (source
 * node and window), so the same field compares equal across refreshes even when the layout shifts
 * under it (a keyboard resizing the window, a scroll-into-view), unlike bounds.
 */
internal data class FocusIdentity(val nodeHash: Int, val viewId: String?)

/**
 * Polls [readFocus] until it reports an input other than [before], or [timeoutMs] elapses. The
 * dispatch (an editor action or `ACTION_FOCUS`) is acknowledged before the app finishes moving
 * focus, so one read can still show the old field. Time and sleeping are injected.
 */
internal fun awaitFocusMoved(
  before: FocusIdentity?,
  readFocus: () -> FocusIdentity?,
  nowMs: () -> Long,
  pause: (Long) -> Unit,
  timeoutMs: Long = FOCUS_MOVE_TIMEOUT_MS,
  pollMs: Long = FOCUS_MOVE_POLL_MS,
): Boolean {
  val start = nowMs()
  while (true) {
    val now = readFocus()
    if (now != null && now != before) return true
    if (nowMs() - start >= timeoutMs) return false
    pause(pollMs)
  }
}

internal const val FOCUS_MOVE_TIMEOUT_MS = 500L
internal const val FOCUS_MOVE_POLL_MS = 25L

/** What delivering the action did, before any focus verification. */
internal data class ImeDispatch(val dispatched: Boolean, val error: String? = null)

internal data class ImeActionVerdict(val success: Boolean, val error: String?)

/**
 * Turns a dispatch and (for next/previous) the focus check into the reply. A failed dispatch is
 * reported as such; next/previous succeed only when the focused input changed. [focusMoved] is null
 * for an action that is not verified by a focus change.
 */
internal fun judgeImeAction(
  action: String,
  mechanism: ImeActionMechanism,
  dispatch: ImeDispatch,
  focusMoved: Boolean?,
): ImeActionVerdict {
  if (!dispatch.dispatched) return ImeActionVerdict(false, dispatch.error ?: "Action failed")
  if (!isFocusMovingImeAction(action) || focusMoved == true) return ImeActionVerdict(true, null)
  val how =
    when (mechanism) {
      ImeActionMechanism.EDITOR_ACTION ->
        "dispatched through the input connection (the field's own handler ran or was offered it)"
      else -> "applied by moving focus directly"
    }
  return ImeActionVerdict(
    false,
    "IME action '$action' was $how, but the focused input did not change " +
      "(an app handler can keep focus, for example on the last field or on a validation " +
      "failure). Observe before retrying.",
  )
}
