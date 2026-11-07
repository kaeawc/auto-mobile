package dev.jasonpearson.automobile.tvfixture.player

import android.view.KeyEvent

/** Maps media key codes to player commands. */
object MediaKeys {
  fun commandFor(keyCode: Int): PlayerCommand? =
    when (keyCode) {
      KeyEvent.KEYCODE_MEDIA_PLAY -> PlayerCommand.PLAY
      KeyEvent.KEYCODE_MEDIA_PAUSE -> PlayerCommand.PAUSE
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_HEADSETHOOK -> PlayerCommand.PLAY_PAUSE
      KeyEvent.KEYCODE_MEDIA_STOP -> PlayerCommand.STOP
      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> PlayerCommand.FAST_FORWARD
      KeyEvent.KEYCODE_MEDIA_REWIND -> PlayerCommand.REWIND
      KeyEvent.KEYCODE_MEDIA_NEXT -> PlayerCommand.NEXT
      KeyEvent.KEYCODE_MEDIA_PREVIOUS -> PlayerCommand.PREVIOUS
      else -> null
    }

  /**
   * The command a key event runs, or null when it runs none. Only the first down event of a press
   * runs a command, so a held key or its up event never repeats it.
   */
  fun commandFor(action: Int, repeatCount: Int, keyCode: Int): PlayerCommand? =
    commandFor(keyCode).takeIf { action == KeyEvent.ACTION_DOWN && repeatCount == 0 }
}
