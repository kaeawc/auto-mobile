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
    // Three commits land before the controller has processed even the first report.
    val reports = listOf("a", "ab", "abc").filter(sync::edit)
    assertEquals(listOf("a", "ab", "abc"), reports)
    assertEquals("abc", sync.text)
    // Lagging echoes arrive in order; none of them rewinds the displayed text.
    assertFalse(sync.observe("a"))
    assertEquals("abc", sync.text)
    assertFalse(sync.observe("ab"))
    assertEquals("abc", sync.text)
    assertFalse(sync.observe("abc"))
    assertEquals("abc", sync.text)
  }

  @Test
  fun `an echo that skips intermediate states still keeps the newest local text`() {
    val sync = OverlayTextFieldSync("")
    sync.edit("a")
    sync.edit("ab")
    assertFalse(sync.observe("ab")) // the "a" snapshot was conflated away
    assertEquals("ab", sync.text)
    assertTrue(sync.edit("abc"))
    assertFalse(sync.observe("abc"))
  }

  @Test
  fun `an authoritative external value wins and discards pending echoes`() {
    val sync = OverlayTextFieldSync("")
    sync.edit("typed")
    assertTrue(sync.observe("from agent"))
    assertEquals("from agent", sync.text)
    // The old report's echo no longer matches anything pending: it is just another value.
    assertTrue(sync.observe("typed"))
    assertEquals("typed", sync.text)
  }

  @Test
  fun `an external value arriving with nothing pending replaces the text`() {
    val sync = OverlayTextFieldSync("old")
    assertTrue(sync.observe("new"))
    assertEquals("new", sync.text)
    assertFalse(sync.observe("new"))
  }

  @Test
  fun `a deleted then retyped value matches its own echoes in order`() {
    val sync = OverlayTextFieldSync("")
    sync.edit("a")
    sync.edit("")
    sync.edit("a")
    assertFalse(sync.observe("a"))
    assertFalse(sync.observe(""))
    assertFalse(sync.observe("a"))
    assertEquals("a", sync.text)
  }
}
