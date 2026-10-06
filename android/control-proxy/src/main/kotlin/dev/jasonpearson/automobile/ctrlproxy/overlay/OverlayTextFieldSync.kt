package dev.jasonpearson.automobile.ctrlproxy.overlay

/**
 * Reconciles one overlay text field's locally typed text with the controller's reported state, so
 * the displayed value never waits on the controller mutex or the event sink.
 *
 * The IME edits [text] immediately via [edit]; each edit is reported outward in order. The
 * controller's state later arrives through [observe]: an observation that matches a reported edit
 * is that edit's echo and leaves the (possibly newer) local text alone, while anything else is an
 * authoritative external update (`update_overlay`) and replaces the local text. Plain Kotlin on
 * purpose: Compose only holds the value and calls these methods.
 */
internal class OverlayTextFieldSync(initial: String) {
  var text: String = initial
    private set

  private val reported = ArrayDeque<String>()

  /** A local edit. Returns true when it changed the text and must be reported outward. */
  fun edit(value: String): Boolean {
    if (value == text) return false
    text = value
    reported.addLast(value)
    return true
  }

  /** The controller-held value. Returns true when it replaced the local text (external update). */
  fun observe(authoritative: String): Boolean {
    val echo = reported.indexOf(authoritative)
    if (echo >= 0) {
      repeat(echo + 1) { reported.removeFirst() }
      return false
    }
    reported.clear()
    if (authoritative == text) return false
    text = authoritative
    return true
  }
}
