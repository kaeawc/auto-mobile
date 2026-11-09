package dev.jasonpearson.automobile.demos

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerCollapseStateTest {
  @Test
  fun hiddenImeOnEntryKeepsComposerExpanded() {
    val state = ComposerCollapseState()
    assertTrue(state.isExpanded)
    assertTrue(state.onImeVisibilityChanged(false).isExpanded)
    assertTrue(state.onImeVisibilityChanged(false).onImeVisibilityChanged(false).isExpanded)
  }

  @Test
  fun collapsesOnlyAfterVisibleImeBecomesHidden() {
    val visible = ComposerCollapseState().onImeVisibilityChanged(true)
    assertTrue(visible.isExpanded)
    assertTrue(visible.onImeVisibilityChanged(true).isExpanded)
    val hidden = visible.onImeVisibilityChanged(false)
    assertFalse(hidden.isExpanded)
    assertFalse(hidden.onImeVisibilityChanged(false).isExpanded)
  }

  @Test
  fun imeVisibilityAloneDoesNotReopenCollapsedComposer() {
    val collapsed =
      ComposerCollapseState().onImeVisibilityChanged(true).onImeVisibilityChanged(false)
    assertFalse(collapsed.onImeVisibilityChanged(true).isExpanded)
  }

  @Test
  fun reopeningWaitsForAnotherVisibleToHiddenTransition() {
    val collapsed =
      ComposerCollapseState().onImeVisibilityChanged(true).onImeVisibilityChanged(false)
    val reopened = collapsed.expand()
    assertTrue(reopened.isExpanded)
    assertTrue(reopened.onImeVisibilityChanged(false).isExpanded)
    assertFalse(reopened.onImeVisibilityChanged(true).onImeVisibilityChanged(false).isExpanded)
  }
}
