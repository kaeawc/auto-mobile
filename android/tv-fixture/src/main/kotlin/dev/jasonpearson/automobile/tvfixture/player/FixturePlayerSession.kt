package dev.jasonpearson.automobile.tvfixture.player

import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.view.KeyEvent
import androidx.core.content.IntentCompat

/**
 * A framework [MediaSession] in front of [PlayerState]. Media keys reach it either through the
 * activity's media controller (the app is in front) or as the system's media button session, and
 * both paths run the same [PlayerCommand] as the on-screen buttons.
 */
class FixturePlayerSession(context: Context, private val onCommand: (PlayerCommand) -> Unit) {
  private val session = MediaSession(context, TAG)

  val token: MediaSession.Token
    get() = session.sessionToken

  init {
    session.setCallback(Callback())
  }

  fun activate() {
    session.isActive = true
  }

  /** Publishes [state] so controllers and `dumpsys media_session` see what the screen shows. */
  fun publish(state: PlayerState) {
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, state.track.id)
        .putString(MediaMetadata.METADATA_KEY_TITLE, state.track.title)
        .putLong(MediaMetadata.METADATA_KEY_DURATION, state.track.durationSeconds * MILLIS)
        .build(),
    )
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(SUPPORTED_ACTIONS)
        .setState(
          if (state.isPlaying) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          state.positionSeconds * MILLIS,
          // The simulated position never ticks, so a controller must not extrapolate it either.
          STILL,
        )
        .build(),
    )
  }

  fun release() {
    session.release()
  }

  private inner class Callback : MediaSession.Callback() {
    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
      val event =
        IntentCompat.getParcelableExtra(
          mediaButtonIntent,
          Intent.EXTRA_KEY_EVENT,
          KeyEvent::class.java,
        ) ?: return super.onMediaButtonEvent(mediaButtonIntent)
      // Keys this player does not know fall through to the framework's default handling.
      if (MediaKeys.commandFor(event.keyCode) == null) {
        return super.onMediaButtonEvent(mediaButtonIntent)
      }
      MediaKeys.commandFor(event.action, event.repeatCount, event.keyCode)?.let(onCommand)
      return true
    }

    override fun onPlay() = onCommand(PlayerCommand.PLAY)

    override fun onPause() = onCommand(PlayerCommand.PAUSE)

    override fun onStop() = onCommand(PlayerCommand.STOP)

    override fun onFastForward() = onCommand(PlayerCommand.FAST_FORWARD)

    override fun onRewind() = onCommand(PlayerCommand.REWIND)

    override fun onSkipToNext() = onCommand(PlayerCommand.NEXT)

    override fun onSkipToPrevious() = onCommand(PlayerCommand.PREVIOUS)
  }

  private companion object {
    const val TAG = "AutoMobileTvFixture"
    const val MILLIS = 1000L
    const val STILL = 0f
    const val SUPPORTED_ACTIONS =
      PlaybackState.ACTION_PLAY or
        PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or
        PlaybackState.ACTION_STOP or
        PlaybackState.ACTION_FAST_FORWARD or
        PlaybackState.ACTION_REWIND or
        PlaybackState.ACTION_SKIP_TO_NEXT or
        PlaybackState.ACTION_SKIP_TO_PREVIOUS
  }
}
