package dev.jasonpearson.automobile.automotivefixture.media

import android.media.MediaDescription
import android.media.MediaMetadata
import android.media.browse.MediaBrowser
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Bundle
import android.service.media.MediaBrowserService

/**
 * Serves the fixed [MediaBrowseTree] to the car media center. Playback is simulated: playing an
 * item only updates the session's metadata and state, so no audio or network is involved.
 */
class FixtureMediaBrowserService : MediaBrowserService() {
  private val tree = MediaBrowseTree.fixture()
  private lateinit var session: MediaSession

  override fun onCreate() {
    super.onCreate()
    session =
      MediaSession(this, "AutoMobileFixture").apply {
        setCallback(
          object : MediaSession.Callback() {
            override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
              val item = mediaId?.let(tree::playable) ?: return
              setMetadata(
                MediaMetadata.Builder()
                  .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, item.mediaId)
                  .putString(MediaMetadata.METADATA_KEY_TITLE, item.title)
                  .putString(MediaMetadata.METADATA_KEY_ARTIST, item.subtitle)
                  .build(),
              )
              setPlaybackState(state(PlaybackState.STATE_PLAYING))
            }

            override fun onPlay() = setPlaybackState(state(PlaybackState.STATE_PLAYING))

            override fun onPause() = setPlaybackState(state(PlaybackState.STATE_PAUSED))

            override fun onStop() = setPlaybackState(state(PlaybackState.STATE_STOPPED))
          },
        )
        setPlaybackState(state(PlaybackState.STATE_STOPPED))
        isActive = true
      }
    sessionToken = session.sessionToken
  }

  override fun onDestroy() {
    session.release()
    super.onDestroy()
  }

  override fun onGetRoot(
    clientPackageName: String,
    clientUid: Int,
    rootHints: Bundle?,
  ): BrowserRoot = BrowserRoot(MediaBrowseTree.ROOT_ID, null)

  override fun onLoadChildren(
    parentId: String,
    result: Result<MutableList<MediaBrowser.MediaItem>>,
  ) {
    result.sendResult(tree.childrenOf(parentId)?.map(::toMediaItem)?.toMutableList())
  }

  private fun toMediaItem(node: MediaNode): MediaBrowser.MediaItem =
    MediaBrowser.MediaItem(
      MediaDescription.Builder()
        .setMediaId(node.mediaId)
        .setTitle(node.title)
        .setSubtitle(node.subtitle)
        .build(),
      if (node.isBrowsable) MediaBrowser.MediaItem.FLAG_BROWSABLE
      else MediaBrowser.MediaItem.FLAG_PLAYABLE,
    )

  private fun state(state: Int): PlaybackState =
    PlaybackState.Builder()
      .setActions(
        PlaybackState.ACTION_PLAY or
          PlaybackState.ACTION_PAUSE or
          PlaybackState.ACTION_STOP or
          PlaybackState.ACTION_PLAY_FROM_MEDIA_ID,
      )
      .setState(state, 0L, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
      .build()
}
