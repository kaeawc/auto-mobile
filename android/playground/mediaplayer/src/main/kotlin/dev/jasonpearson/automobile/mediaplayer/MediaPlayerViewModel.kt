package dev.jasonpearson.automobile.mediaplayer

import android.content.Context
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for managing ExoPlayer instances and media playback state. Handles video and audio
 * playback with proper lifecycle management.
 */
class MediaPlayerViewModel : ViewModel(), MediaPlaybackControls {

  private val _playerState = MutableStateFlow<ExoPlayer?>(null)
  override val playerState: StateFlow<ExoPlayer?> = _playerState.asStateFlow()

  private val _isPlaying = MutableStateFlow(false)
  val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

  private val _currentPosition = MutableStateFlow(0L)
  val currentPosition: StateFlow<Long> = _currentPosition.asStateFlow()

  private val _duration = MutableStateFlow(0L)
  val duration: StateFlow<Long> = _duration.asStateFlow()

  private val _playbackError = MutableStateFlow<String?>(null)
  val playbackError: StateFlow<String?> = _playbackError.asStateFlow()

  private val _shouldShowControls = MutableStateFlow(false)
  val shouldShowControls: StateFlow<Boolean> = _shouldShowControls.asStateFlow()

  private var savedPosition: Long = 0L
  private var isFirstLoad: Boolean = true

  /** Initialize ExoPlayer with the given video resource. Supports both video and audio playback. */
  fun initializePlayer(context: Context, videoResource: VideoResource) {
    if (_playerState.value == null) {
      viewModelScope.launch {
        try {
          Log.d("MediaPlayerVM", "Initializing player with resource: $videoResource")

          // Create a more robust ExoPlayer with better codec support
          val renderersFactory =
            DefaultRenderersFactory(context)
              .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)

          val exoPlayer =
            ExoPlayer.Builder(context).setRenderersFactory(renderersFactory).build().also { player
              ->
              val mediaItem = videoResource.toMediaItem(context)
              Log.d("MediaPlayerVM", "Created MediaItem: $mediaItem")
              if (mediaItem != null) {
                player.setMediaItem(mediaItem)
                player.prepare()
                // Auto-play on first load, respect saved state on subsequent loads
                player.playWhenReady = isFirstLoad
                player.seekTo(savedPosition)

                // Hide controls initially on first load
                if (isFirstLoad) {
                  _shouldShowControls.value = false
                  // Auto-show controls after a delay if video is playing
                  //                  viewModelScope.launch {
                  //                    delay(3000) // Hide controls for 3 seconds
                  //                    if (_isPlaying.value) {
                  //                      _shouldShowControls.value = true
                  //                    }
                  //                  }
                } else {
                  //                  _shouldShowControls.value = true
                }

                Log.d("MediaPlayerVM", "Player prepared and ready, autoplay: $isFirstLoad")

                // Add player event listeners
                player.addListener(
                  object : Player.Listener {
                    override fun onPlayerError(error: PlaybackException) {
                      Log.e("MediaPlayerVM", "Player error: ${error.message}", error)
                      _playbackError.value = playbackErrorMessage(error)
                    }

                    override fun onIsPlayingChanged(isPlaying: Boolean) {
                      Log.d("MediaPlayerVM", "Playing state changed: $isPlaying")
                      _isPlaying.value = isPlaying
                      if (isPlaying) {
                        startPositionUpdates()
                        // Mark as no longer first load once playback starts
                        isFirstLoad = false
                      }
                    }

                    override fun onPlaybackStateChanged(playbackState: Int) {
                      val stateString =
                        when (playbackState) {
                          Player.STATE_IDLE -> "IDLE"
                          Player.STATE_BUFFERING -> "BUFFERING"
                          Player.STATE_READY -> "READY"
                          Player.STATE_ENDED -> "ENDED"
                          else -> "UNKNOWN"
                        }
                      Log.d("MediaPlayerVM", "Playback state changed: $stateString")
                      when (playbackState) {
                        Player.STATE_READY -> {
                          _duration.value = player.duration
                          Log.d("MediaPlayerVM", "Duration: ${player.duration}")
                        }
                        Player.STATE_IDLE,
                        Player.STATE_BUFFERING,
                        Player.STATE_ENDED -> Unit
                      }
                    }

                    override fun onPositionDiscontinuity(
                      oldPosition: Player.PositionInfo,
                      newPosition: Player.PositionInfo,
                      reason: Int,
                    ) {
                      // Hide controls when user seeks to the beginning
                      if (
                        reason == Player.DISCONTINUITY_REASON_SEEK && newPosition.positionMs <= 100
                      ) { // Within 100ms of start
                        Log.d("MediaPlayerVM", "Rewound to start, hiding controls")
                        _shouldShowControls.value = false
                        // Auto-show controls after delay if playing
                        //                      if (player.isPlaying) {
                        //                        viewModelScope.launch {
                        //                          delay(500)
                        //                          if (_isPlaying.value) {
                        //                            _shouldShowControls.value = true
                        //                          }
                        //                        }
                        //                      }
                      }
                    }
                  },
                )
              } else {
                Log.e("MediaPlayerVM", "MediaItem is null")
                _playbackError.value = "No valid media source provided"
                return@launch
              }
            }

          _playerState.value = exoPlayer
          clearError()
        } catch (e: Exception) {
          Log.e("MediaPlayerVM", "Failed to initialize player", e)
          _playbackError.value = "Failed to initialize player: ${e.message}"
        }
      }
    }
  }

  /** Start updating position and duration while playing. */
  private fun startPositionUpdates() {
    viewModelScope.launch {
      var previousPosition = 0L
      while (_isPlaying.value && _playerState.value != null) {
        _playerState.value?.let { player ->
          val currentPos = player.currentPosition
          _currentPosition.value = currentPos

          // Check if user seeked to beginning (significant backward jump to near 0)
          if (previousPosition > 1000 && currentPos <= 100) {
            Log.d("MediaPlayerVM", "Detected seek to start, hiding controls")
            _shouldShowControls.value = false
            // Auto-show controls after delay
            //            viewModelScope.launch {
            //              delay(500)
            //              if (_isPlaying.value) {
            //                _shouldShowControls.value = true
            //              }
            //            }
          }

          previousPosition = currentPos

          if (player.duration > 0) {
            _duration.value = player.duration
          }
        }
        delay(100) // Update every 100ms for smooth progress
      }
    }
  }

  /** Seek to a specific position in the media. */
  fun seekTo(positionMs: Long) {
    _playerState.value?.seekTo(positionMs)
    _currentPosition.value = positionMs
  }

  /** Save current playback state for configuration changes. */
  fun savePlayerState() {
    _playerState.value?.let { player -> savedPosition = player.currentPosition }
  }

  /** Toggle visibility of player controls. */
  fun toggleControlsVisibility() {
    _shouldShowControls.value = !_shouldShowControls.value
  }

  /** Show player controls. */
  fun showControls() {
    _shouldShowControls.value = true
  }

  /** Hide player controls. */
  fun hideControls() {
    _shouldShowControls.value = false
  }

  /** Release the ExoPlayer and clean up resources. */
  fun releasePlayer() {
    savePlayerState()
    _playerState.value?.release()
    _playerState.value = null
    _isPlaying.value = false
    _currentPosition.value = 0L
    _duration.value = 0L
  }

  /** Clear playback error state. */
  fun clearError() {
    _playbackError.value = null
  }

  override fun onCleared() {
    releasePlayer()
  }
}

/** Minimal playback surface for the foreground-only host lifecycle policy. */
internal interface HostPlayback {
  val playWhenReady: Boolean

  fun pause()
}

/**
 * Clear play intent, including while buffering, leaving paused and uninitialized hosts untouched.
 */
internal fun HostPlayback?.onHostStopped() {
  if (this?.playWhenReady == true) pause()
}
