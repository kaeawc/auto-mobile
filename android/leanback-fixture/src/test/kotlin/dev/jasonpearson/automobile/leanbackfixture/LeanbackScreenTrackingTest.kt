package dev.jasonpearson.automobile.leanbackfixture

import android.content.Intent
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationListener
import dev.jasonpearson.automobile.sdk.NavigationSource
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class LeanbackScreenTrackingTest {
  private val events = mutableListOf<NavigationEvent>()
  private val listener = NavigationListener { events += it }

  @Before
  fun addListener() {
    AutoMobileSDK.addNavigationListener(listener)
  }

  @After
  fun removeListener() {
    AutoMobileSDK.removeNavigationListener(listener)
    AutoMobileSDK.shutdown()
  }

  @Test
  fun `browse activity reports BrowseDestination on resume`() {
    Robolectric.buildActivity(MainActivity::class.java).setup().use {
      assertEquals(listOf("BrowseDestination"), events.map { it.destination })
      assertEquals(NavigationSource.ACTIVITY, events.single().source)
    }
  }

  @Test
  fun `detail activity reports DetailDestination with the card id on resume`() {
    val intent =
      Intent(RuntimeEnvironment.getApplication(), DetailActivity::class.java)
        .putExtra(LeanbackFixtureCatalog.EXTRA_CARD_ID, "card_movies_03")
    Robolectric.buildActivity(DetailActivity::class.java, intent).setup().use {
      val event = events.single()
      assertEquals("DetailDestination", event.destination)
      assertEquals(mapOf("cardId" to "card_movies_03"), event.arguments)
    }
  }

  @Test
  fun `resuming again reports the screen again`() {
    Robolectric.buildActivity(MainActivity::class.java).setup().use { controller ->
      controller.pause().resume()
      assertEquals(listOf("BrowseDestination", "BrowseDestination"), events.map { it.destination })
    }
  }

  @Test
  fun `screen names are the navigation graph contract`() {
    assertEquals("BrowseDestination", LeanbackScreen.Browse.name)
    assertEquals(LeanbackScreen("DetailDestination"), LeanbackScreen.detail(null))
  }
}
