package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AccessibilityEventDispatcherTest {
  /** A service with a configurable number of connected clients, logging every update in order. */
  private class FakeService : AccessibilityEventDispatcher.Host {
    var clients = 1
    val calls = mutableListOf<String>()

    override fun forgetRememberedInsert() {
      calls += "forget"
    }

    override fun onTextSelectionChanged(fromIndex: Int, toIndex: Int) {
      calls += "selection:$fromIndex-$toIndex"
    }

    override fun onWindowStateChanged(className: String?) {
      calls += "window:$className"
    }

    override fun advanceFrameContext() {
      calls += "advance"
    }

    override fun connectionCount() = clients

    override fun recordInteraction(event: AccessibilityEvent, dispatch: InteractionDispatch) {
      calls += "interaction:$dispatch"
    }

    override fun refreshHierarchy() {
      calls += "refresh"
    }
  }

  private val service = FakeService()
  private val dispatcher = AccessibilityEventDispatcher(service)

  @Suppress("DEPRECATION") // obtain(int) is the only constructor below API 30.
  private fun event(type: Int) = AccessibilityEvent.obtain(type)

  @Test
  fun `an observed window change forgets the caret, navigates and refreshes`() {
    dispatcher.dispatch(
      event(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED).apply { className = "app.Main" },
    )

    assertEquals(
      listOf("forget", "window:app.Main", "advance", "interaction:NAVIGATE", "refresh"),
      service.calls,
    )
  }

  @Test
  fun `with no client connected the token still advances but no push work runs`() {
    service.clients = 0

    dispatcher.dispatch(event(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED))
    dispatcher.dispatch(event(AccessibilityEvent.TYPE_VIEW_CLICKED))
    dispatcher.dispatch(event(AccessibilityEvent.TYPE_VIEW_SCROLLED))

    assertEquals(listOf("advance", "advance"), service.calls)
  }

  @Test
  fun `an observed click is recorded as an interaction`() {
    dispatcher.dispatch(event(AccessibilityEvent.TYPE_VIEW_CLICKED))

    assertEquals(listOf("interaction:TAP"), service.calls)
  }

  @Test
  fun `a selection change moves the caret without forgetting it`() {
    dispatcher.dispatch(
      event(AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED).apply {
        fromIndex = 2
        toIndex = 5
      },
    )

    assertEquals("selection:2-5", service.calls.first())
    assertEquals(false, "forget" in service.calls)
  }

  @Test
  fun `focus changes forget the caret`() {
    for (type in
      listOf(
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      )) {
      service.calls.clear()

      dispatcher.dispatch(event(type))

      assertEquals("type $type", "forget", service.calls.first())
    }
  }
}
