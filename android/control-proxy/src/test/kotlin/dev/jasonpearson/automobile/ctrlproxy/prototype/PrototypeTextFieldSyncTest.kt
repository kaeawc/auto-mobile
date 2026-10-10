package dev.jasonpearson.automobile.ctrlproxy.overlay

import org.junit.Assert.*
import org.junit.Test

/** The pure half of the text field's "shown value never lags its own input" contract. */
class OverlayTextFieldSyncTest {
  @Test
  fun `an edit shows immediately and is reported, an unchanged value is not`() {
    val sync = OverlayTextFieldSync("")
    assertTrue(sync.edit("a"))
    assertEquals("a", sync.text)
    assertFalse(sync.edit("a"))
  }

  @Test
  fun `fast typing keeps every character while the controller echoes lag behind`() {
    val sync = OverlayTextFieldSync("")
    val reports = listOf("a", "ab", "abc").filter(sync::edit)
    assertEquals(listOf("a", "ab", "abc"), reports)
    // Lagging echoes at the same epoch never rewind the displayed text.
    for (echo in listOf("a", "ab", "abc")) {
      assertFalse(sync.observe(echo, 0))
      assertEquals("abc", sync.text)
    }
  }

  @Test
  fun `a newer epoch is authoritative even when its value equals an edit still in flight`() {
    val sync = OverlayTextFieldSync("")
    sync.edit("a")
    sync.edit("ab")
    // An authoritative replacement sets the key to "a" while both reports are still queued.
    assertTrue(sync.observe("a", 1))
    assertEquals("a", sync.text)
    assertEquals(1, sync.epoch)
  }

  @Test
  fun `a newer epoch with a different value replaces the text and later edits carry it`() {
    val sync = OverlayTextFieldSync("")
    sync.edit("typed")
    assertTrue(sync.observe("from agent", 1))
    assertEquals("from agent", sync.text)
    assertEquals(1, sync.epoch)
    // The old report's echo at the old epoch is ignored, not adopted.
    assertFalse(sync.observe("typed", 0))
    assertEquals("from agent", sync.text)
  }

  @Test
  fun `a newer epoch with the same value still moves the epoch so edits are accepted`() {
    val sync = OverlayTextFieldSync("same", 0)
    assertFalse(sync.observe("same", 2))
    assertEquals(2, sync.epoch)
  }

  @Test
  fun `a reverted rejected edit shows the accepted text again`() {
    val sync = OverlayTextFieldSync("ok", 0)
    sync.edit("ok and far too much")
    // The controller kept "ok" and moved the epoch.
    assertTrue(sync.observe("ok", 1))
    assertEquals("ok", sync.text)
  }

  @Test
  fun `the same value and epoch is a no-op`() {
    val sync = OverlayTextFieldSync("old", 3)
    assertFalse(sync.observe("new", 3))
    assertEquals("old", sync.text)
  }
}
