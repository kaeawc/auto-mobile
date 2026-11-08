package dev.jasonpearson.automobile.demos

/** A composer stays expanded until its keyboard has been visible and then hides. */
data class ComposerCollapseState(
  val isExpanded: Boolean = true,
  private val imeWasVisible: Boolean = false,
) {
  fun onImeVisibilityChanged(imeVisible: Boolean): ComposerCollapseState =
    copy(isExpanded = isExpanded && !(imeWasVisible && !imeVisible), imeWasVisible = imeVisible)

  fun expand(): ComposerCollapseState = ComposerCollapseState()
}
