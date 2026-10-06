package dev.jasonpearson.automobile.ctrlproxy.overlay

/**
 * Reconciles one overlay text field's locally typed text with the controller's state, so the
 * displayed value never waits on the controller mutex or the event sink.
 *
 * The IME edits [text] immediately via [edit]; each edit is reported outward in order, stamped with
 * [epoch]. The controller moves a key's epoch whenever its text is replaced from outside the field
 * (an `update_overlay`, or a rejected edit being reverted) and never for the field's own accepted
 * edits. So [observe] needs no value matching: a state seen at the same epoch is only the lagging
 * echo of our own reports and leaves the (possibly newer) local text alone, while a newer epoch is
 * authoritative and always wins, even when its value equals an edit still in flight. Edits stamped
 * with an older epoch are dropped by the controller. Plain Kotlin on purpose: Compose only holds
 * the value and calls these methods.
 */
internal class OverlayTextFieldSync(initialText: String, initialEpoch: Int = 0) {
  var text: String = initialText
    private set

  var epoch: Int = initialEpoch
    private set

  /** A local edit. Returns true when it changed the text and must be reported outward. */
  fun edit(value: String): Boolean {
    if (value == text) return false
    text = value
    return true
  }

  /** The controller-held value. Returns true when it replaced the local text. */
  fun observe(authoritative: String, authoritativeEpoch: Int): Boolean {
    if (authoritativeEpoch <= epoch) return false
    epoch = authoritativeEpoch // Later edits are stamped with it, so the controller accepts them.
    if (authoritative == text) return false
    text = authoritative
    return true
  }
}
