package dev.jasonpearson.automobile.tvfixture.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.jasonpearson.automobile.tvfixture.TvFixtureCatalog
import dev.jasonpearson.automobile.tvfixture.player.PlayerState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FixtureAppScreenTrackingTest {
  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val screens = mutableListOf<String>()

  private fun launch() {
    compose.setContent {
      FixtureApp(
        player = PlayerState(),
        onPlayerCommand = {},
        screenTracker = { screens += it.screenName },
      )
    }
    compose.waitForIdle()
  }

  private fun pressBack() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  @Test
  fun `browse is reported on launch`() {
    launch()
    assertEquals(listOf("BrowseDestination"), screens)
  }

  @Test
  fun `search is reported when opened and browse again after back`() {
    launch()
    compose.onNodeWithTag(TvFixtureCatalog.NAV_SEARCH).performClick()
    compose.waitForIdle()
    pressBack()
    assertEquals(listOf("BrowseDestination", "SearchDestination", "BrowseDestination"), screens)
  }

  @Test
  fun `player is reported from the browse player button`() {
    launch()
    compose.onNodeWithTag(TvFixtureCatalog.NAV_PLAYER).performClick()
    compose.waitForIdle()
    assertEquals(listOf("BrowseDestination", "PlayerDestination"), screens)
  }

  @Test
  fun `detail is reported for a selected card and player from its play button`() {
    launch()
    compose.onNodeWithTag("card_featured_01").performClick()
    compose.waitForIdle()
    compose.onNodeWithTag("detail_play").performClick()
    compose.waitForIdle()
    assertEquals(
      listOf("BrowseDestination", "DetailDestination", "PlayerDestination"),
      screens,
    )
  }
}
