package dev.jasonpearson.automobile.ctrlproxy

import android.view.inputmethod.EditorInfo
import dev.jasonpearson.automobile.ctrlproxy.ime.CtrlProxyIme

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
 * done/go/send/search are one request, "submit": the keyboard's action key runs whatever action the
 * FIELD declared, and `ACTION_IME_ENTER` (the path without the AutoMobile keyboard) does the same,
 * so the caller's word never selects between them (#10219).
 */
internal fun isSubmitImeAction(action: String): Boolean =
  action == "done" || action == "go" || action == "send" || action == "search"

/**
 * The `IME_ACTION_*` id to send through the live input connection, or null when the editor has no
 * action to run and the Enter fallback (what the path without the keyboard uses) should run
 * instead. next/previous are literal. A submit word sends the editor's own configured action from
 * [imeOptions], so `done` on a field declaring `actionSearch` still searches; a field declaring no
 * action, or a multi-line one that keeps Enter for a newline (`IME_FLAG_NO_ENTER_ACTION`), has
 * none.
 */
internal fun resolveEditorActionId(action: String, imeOptions: Int): Int? {
  val requested = imeEditorActionId(action) ?: return null
  if (!isSubmitImeAction(action)) return requested
  if (imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0) return null
  return when (val declared = imeOptions and EditorInfo.IME_MASK_ACTION) {
    EditorInfo.IME_ACTION_NONE,
    EditorInfo.IME_ACTION_UNSPECIFIED -> null
    else -> declared
  }
}

/** The wire name of an `IME_ACTION_*` id, reported as `editorAction`. */
internal fun imeEditorActionName(actionId: Int): String =
  when (actionId) {
    EditorInfo.IME_ACTION_NEXT -> "next"
    EditorInfo.IME_ACTION_PREVIOUS -> "previous"
    EditorInfo.IME_ACTION_DONE -> "done"
    EditorInfo.IME_ACTION_GO -> "go"
    EditorInfo.IME_ACTION_SEND -> "send"
    EditorInfo.IME_ACTION_SEARCH -> "search"
    else -> "action-$actionId"
  }

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

/** One read of the active window's input focus. */
internal sealed interface FocusRead {
  /** No active window could be read (mid transition, or the service lost it). */
  object Unreadable : FocusRead

  /** The window was read and no input holds focus. */
  object NoInput : FocusRead

  data class Input(val identity: FocusIdentity) : FocusRead
}

/** What happened to the focused input after an action was dispatched. */
internal enum class FocusChange {
  /** Another input holds focus. */
  MOVED,
  /** No input holds focus any more: the action took effect and the screen moved on. */
  LEFT_FIELD,
  /** The same input still holds focus. */
  UNCHANGED,
  /** Focus could not be read when the wait ended. */
  UNREADABLE,
}

/**
 * Polls [readFocus] until the focus differs from [before], or [timeoutMs] elapses. The dispatch (an
 * editor action or `ACTION_FOCUS`) is acknowledged before the app finishes moving focus, so one
 * read can still show the old field. A read with no focused input at all means focus left the field
 * entirely (the app handler navigated away): the action took effect, which is not the same as "not
 * moved". Time and sleeping are injected.
 */
internal fun awaitFocusChange(
  before: FocusIdentity?,
  readFocus: () -> FocusRead,
  nowMs: () -> Long,
  pause: (Long) -> Unit,
  timeoutMs: Long = FOCUS_MOVE_TIMEOUT_MS,
  pollMs: Long = FOCUS_MOVE_POLL_MS,
): FocusChange {
  val start = nowMs()
  while (true) {
    val timedOut = nowMs() - start >= timeoutMs
    when (val read = readFocus()) {
      FocusRead.NoInput -> return FocusChange.LEFT_FIELD
      is FocusRead.Input -> {
        if (read.identity != before) return FocusChange.MOVED
        if (timedOut) return FocusChange.UNCHANGED
      }
      FocusRead.Unreadable -> if (timedOut) return FocusChange.UNREADABLE
    }
    pause(pollMs)
  }
}

internal const val FOCUS_MOVE_TIMEOUT_MS = 500L
internal const val FOCUS_MOVE_POLL_MS = 25L

/**
 * What delivering the action did, before any focus verification.
 *
 * [mechanism] and [editorAction] describe what was actually used (they differ from the planned step
 * when the keyboard fell back). [indeterminate] marks a dispatch whose outcome is unknown (it may
 * still be delivered), so the reply must not invite a retry. [fallBack] asks the caller to deliver
 * the action by the path that needs no input connection: the editor has no action to run, or the
 * keyboard went away between the liveness check and the dispatch.
 */
internal data class ImeDispatch(
  val dispatched: Boolean,
  val error: String? = null,
  val mechanism: ImeActionMechanism? = null,
  val editorAction: String? = null,
  val indeterminate: Boolean = false,
  val fallBack: Boolean = false,
)

/**
 * Maps what the keyboard reported to a dispatch; a null [outcome] is the wait timing out. The
 * editor rejecting the action means nothing ran, so that failure may be retried; a timeout may
 * still be delivered later, so it may not.
 */
internal fun dispatchFromEditorOutcome(
  action: String,
  outcome: CtrlProxyIme.EditorActionOutcome?,
): ImeDispatch =
  when (outcome) {
    is CtrlProxyIme.EditorActionOutcome.Sent -> {
      val sent = imeEditorActionName(outcome.actionId)
      if (outcome.handled) {
        ImeDispatch(true, mechanism = ImeActionMechanism.EDITOR_ACTION, editorAction = sent)
      } else {
        ImeDispatch(
          false,
          "The editor did not handle IME action '$sent' (requested '$action'): no live input " +
            "connection or the editor rejected it",
          mechanism = ImeActionMechanism.EDITOR_ACTION,
          editorAction = sent,
        )
      }
    }
    CtrlProxyIme.EditorActionOutcome.NoEditorAction,
    CtrlProxyIme.EditorActionOutcome.NoConnection -> ImeDispatch(false, fallBack = true)
    null ->
      ImeDispatch(
        false,
        "Timed out waiting for the keyboard to dispatch IME action '$action'; its outcome is " +
          "indeterminate. Do not retry automatically. Observe before retrying.",
        mechanism = ImeActionMechanism.EDITOR_ACTION,
        indeterminate = true,
      )
  }

/**
 * The reply. [retryable] is false when the action was dispatched but its effect could not be
 * confirmed: a retry would deliver it twice (a Next handler that submits, a validation that runs
 * again).
 */
internal data class ImeActionVerdict(
  val success: Boolean,
  val error: String?,
  val retryable: Boolean = true,
  val mechanism: ImeActionMechanism? = null,
  val editorAction: String? = null,
)

/**
 * Turns a dispatch and (for next/previous) the focus check into the reply. A failed dispatch is
 * reported as such; next/previous succeed only when focus moved to another input or left the field
 * entirely. [focusChange] is null for an action that is not verified by a focus change.
 */
internal fun judgeImeAction(
  action: String,
  mechanism: ImeActionMechanism,
  dispatch: ImeDispatch,
  focusChange: FocusChange?,
): ImeActionVerdict {
  val used = dispatch.mechanism ?: mechanism
  if (!dispatch.dispatched) {
    return ImeActionVerdict(
      false,
      dispatch.error ?: "Action failed",
      retryable = !dispatch.indeterminate,
      mechanism = used,
      editorAction = dispatch.editorAction,
    )
  }
  val settled =
    !isFocusMovingImeAction(action) ||
      focusChange == FocusChange.MOVED ||
      focusChange == FocusChange.LEFT_FIELD
  if (settled) {
    return ImeActionVerdict(true, null, mechanism = used, editorAction = dispatch.editorAction)
  }
  return ImeActionVerdict(
    false,
    unconfirmedFocusError(action, used, focusChange),
    retryable = false,
    mechanism = used,
    editorAction = dispatch.editorAction,
  )
}

private fun unconfirmedFocusError(
  action: String,
  mechanism: ImeActionMechanism,
  focusChange: FocusChange?,
): String {
  val how =
    when (mechanism) {
      ImeActionMechanism.EDITOR_ACTION ->
        "dispatched through the input connection (the field's own handler ran or was offered it)"
      else -> "applied by moving focus directly"
    }
  val outcome =
    if (focusChange == FocusChange.UNREADABLE) "the focused input could not be read afterwards"
    else "the focused input did not change"
  return "IME action '$action' was $how, but $outcome (an app handler can keep focus, for " +
    "example on the last field or on a validation failure); its outcome is indeterminate. " +
    "Do not retry automatically. Observe before retrying."
}
