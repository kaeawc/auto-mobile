package dev.jasonpearson.automobile.automotivefixture.media

import android.content.Context
import android.content.Intent
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
              mediaId?.let(tree::playable)?.let(::play)
            }

            override fun onPlayFromSearch(query: String?, extras: Bundle?) {
              tree.search(query)?.let(::play)
            }

            override fun onPlay() = setPlaybackState(state(PlaybackState.STATE_PLAYING))

            override fun onPause() = setPlaybackState(state(PlaybackState.STATE_PAUSED))

            override fun onStop() {
              setPlaybackState(state(PlaybackState.STATE_STOPPED))
              stopSelf()
            }
          },
        )
        setPlaybackState(state(PlaybackState.STATE_STOPPED))
        isActive = true
      }
    sessionToken = session.sessionToken
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_PLAY_FROM_SEARCH) {
      tree.search(intent.getStringExtra(EXTRA_QUERY))?.let(::play)
    }
    return START_NOT_STICKY
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

  private fun play(item: MediaNode) {
    // Keep the session alive while playing, even after every client unbinds.
    startService(Intent(this, FixtureMediaBrowserService::class.java))
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, item.mediaId)
        .putString(MediaMetadata.METADATA_KEY_TITLE, item.title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, item.subtitle)
        .build(),
    )
    session.setPlaybackState(state(PlaybackState.STATE_PLAYING))
  }

  private fun state(state: Int): PlaybackState =
    PlaybackState.Builder()
      .setActions(
        PlaybackState.ACTION_PLAY or
          PlaybackState.ACTION_PAUSE or
          PlaybackState.ACTION_STOP or
          PlaybackState.ACTION_PLAY_FROM_MEDIA_ID or
          PlaybackState.ACTION_PLAY_FROM_SEARCH,
      )
      .setState(state, 0L, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
      .build()

  companion object {
    private const val ACTION_PLAY_FROM_SEARCH =
      "dev.jasonpearson.automobile.automotivefixture.action.PLAY_FROM_SEARCH"
    private const val EXTRA_QUERY = "query"

    /** Start intent that plays the first [MediaBrowseTree.search] match for [query]. */
    fun playFromSearchIntent(context: Context, query: String?): Intent =
      Intent(context, FixtureMediaBrowserService::class.java)
        .setAction(ACTION_PLAY_FROM_SEARCH)
        .putExtra(EXTRA_QUERY, query)
  }
}
