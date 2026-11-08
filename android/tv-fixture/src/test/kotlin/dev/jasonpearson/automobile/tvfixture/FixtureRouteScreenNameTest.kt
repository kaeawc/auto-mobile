package dev.jasonpearson.automobile.tvfixture

import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationListener
import dev.jasonpearson.automobile.sdk.NavigationSource
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FixtureRouteScreenNameTest {
  @Test
  fun `every route has a stable screen name`() {
    assertEquals("BrowseDestination", FixtureRoute.Browse.screenName)
    assertEquals("SearchDestination", FixtureRoute.Search.screenName)
    assertEquals("PlayerDestination", FixtureRoute.Player.screenName)
    assertEquals("DetailDestination", FixtureRoute.Detail("card_movies_03").screenName)
    assertEquals(
      mapOf("cardId" to "card_movies_03"),
      FixtureRoute.Detail("card_movies_03").arguments,
    )
    assertEquals(emptyMap<String, String>(), FixtureRoute.Browse.arguments)
  }

  @Test
  fun `sdk tracker emits the route's screen name as a navigation event`() {
    val events = mutableListOf<NavigationEvent>()
    val listener = NavigationListener { events += it }
    AutoMobileSDK.addNavigationListener(listener)
    try {
      SdkScreenTracker.onScreen(FixtureRoute.Search)
      SdkScreenTracker.onScreen(FixtureRoute.Detail("card_shows_12"))
    } finally {
      AutoMobileSDK.removeNavigationListener(listener)
    }
    assertEquals(listOf("SearchDestination", "DetailDestination"), events.map { it.destination })
    assertEquals(NavigationSource.COMPOSE_NAVIGATION, events.first().source)
    assertEquals(mapOf("cardId" to "card_shows_12"), events.last().arguments)
  }
}
