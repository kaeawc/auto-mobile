package dev.jasonpearson.automobile.automotivefixture.media

import android.app.Activity
import android.app.SearchManager
import android.os.Bundle

/**
 * Receives `MEDIA_PLAY_FROM_SEARCH` ("play X" from a voice assistant), hands the query to
 * [FixtureMediaBrowserService], and finishes without showing UI.
 */
class PlayFromSearchActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startService(
      FixtureMediaBrowserService.playFromSearchIntent(
        this,
        intent?.getStringExtra(SearchManager.QUERY),
      ),
    )
    finish()
  }
}
