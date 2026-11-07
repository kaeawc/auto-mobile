package dev.jasonpearson.automobile.tvfixture.player

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaKeysTest {
  @Test
  fun `media key codes map to commands named like pressButton buttons`() {
    val mapped =
      mapOf(
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "playPause",
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "fastForward",
        KeyEvent.KEYCODE_MEDIA_REWIND to "rewind",
        KeyEvent.KEYCODE_MEDIA_NEXT to "next",
        KeyEvent.KEYCODE_MEDIA_PREVIOUS to "previous",
        KeyEvent.KEYCODE_MEDIA_PLAY to "play",
        KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",
        KeyEvent.KEYCODE_MEDIA_STOP to "stop",
        KeyEvent.KEYCODE_HEADSETHOOK to "playPause",
      )
    mapped.forEach { (keyCode, label) -> assertEquals(label, MediaKeys.commandFor(keyCode)?.label) }
  }

  @Test
  fun `non-media keys map to nothing`() {
    assertNull(MediaKeys.commandFor(KeyEvent.KEYCODE_DPAD_CENTER))
    assertNull(MediaKeys.commandFor(KeyEvent.KEYCODE_BACK))
  }

  @Test
  fun `only the first down event of a press runs a command`() {
    val code = KeyEvent.KEYCODE_MEDIA_NEXT
    assertEquals(PlayerCommand.NEXT, MediaKeys.commandFor(KeyEvent.ACTION_DOWN, 0, code))
    assertNull(MediaKeys.commandFor(KeyEvent.ACTION_DOWN, 1, code))
    assertNull(MediaKeys.commandFor(KeyEvent.ACTION_UP, 0, code))
  }
}
