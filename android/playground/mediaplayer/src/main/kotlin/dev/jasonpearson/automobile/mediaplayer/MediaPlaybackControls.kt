package dev.jasonpearson.automobile.mediaplayer

import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.flow.StateFlow

/** Direct player commands shared by the ViewModel's playback surface. */
interface MediaPlaybackControls {
  val playerState: StateFlow<ExoPlayer?>

  /** Play or pause media playback. */
  fun togglePlayPause() {
    playerState.value?.let { player ->
      if (player.isPlaying) {
        player.pause()
      } else {
        player.play()
      }
    }
  }

  /** Playground scenarios are foreground-only; returning to the host does not auto-resume. */
  fun onHostStopped() {
    val player = playerState.value ?: return
    val playback =
      object : HostPlayback {
        override val playWhenReady: Boolean
          get() = player.playWhenReady

        override fun pause() = player.pause()
      }
    playback.onHostStopped()
  }

  /** Set playback volume (0.0 to 1.0). */
  fun setVolume(volume: Float) {
    playerState.value?.volume = volume.coerceIn(0f, 1f)
  }
}
