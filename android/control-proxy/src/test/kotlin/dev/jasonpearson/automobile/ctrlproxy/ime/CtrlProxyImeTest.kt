package dev.jasonpearson.automobile.ctrlproxy.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CtrlProxyImeTest {
  @Test
  fun `profile completion waits until posted apply persists selection`() {
    var queued: Runnable? = null
    var persisted = "direct"
    var acknowledged = false

    CtrlProxyIme.postProfileChange(
      post = { action ->
        queued = action
        true
      },
      apply = {
        persisted = "gboard"
        true
      },
      onComplete = { success ->
        assertTrue(success)
        assertEquals("gboard", persisted)
        acknowledged = true
      },
    )

    assertFalse(acknowledged)
    assertEquals("direct", persisted)
    requireNotNull(queued).run()
    assertTrue(acknowledged)
  }
}
