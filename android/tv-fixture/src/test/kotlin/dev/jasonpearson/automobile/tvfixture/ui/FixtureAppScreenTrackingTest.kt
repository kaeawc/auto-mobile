package dev.jasonpearson.automobile.tvfixture.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
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

  // tv-material buttons and cards ignore touch input, so select them through their click action.
  private fun select(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.OnClick)
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
    select(TvFixtureCatalog.NAV_SEARCH)
    pressBack()
    assertEquals(listOf("BrowseDestination", "SearchDestination", "BrowseDestination"), screens)
  }

  @Test
  fun `player is reported from the browse player button`() {
    launch()
    select(TvFixtureCatalog.NAV_PLAYER)
    assertEquals(listOf("BrowseDestination", "PlayerDestination"), screens)
  }

  @Test
  fun `detail is reported for a selected card and player from its play button`() {
    launch()
    select("card_featured_01")
    select("detail_play")
    assertEquals(
      listOf("BrowseDestination", "DetailDestination", "PlayerDestination"),
      screens,
    )
  }
}
