package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.core.daemon.SessionReleaseReason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReleasedNoticeTextTest {
  @Test
  fun `a hidden-window release says the window was hidden, not inactivity`() {
    val text = releasedNoticeText(SessionReleaseReason.HIDDEN_WINDOW)

    assertTrue(text.contains("window was hidden"))
    assertFalse(text.contains("inactivity"))
  }

  @Test
  fun `a daemon release names the daemon and its causes`() {
    val text = releasedNoticeText(SessionReleaseReason.DAEMON_RELEASED)

    assertTrue(text.startsWith("Released by the daemon"))
    assertTrue(text.contains("idle") && text.contains("restarted"))
  }

  @Test
  fun `an unknown reason falls back to the daemon wording`() {
    assertEquals(
      releasedNoticeText(SessionReleaseReason.DAEMON_RELEASED),
      releasedNoticeText(null),
    )
  }
}
