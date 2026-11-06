package dev.jasonpearson.automobile.tvfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class FixtureStateTest {
  private val initial = FixtureState()

  @Test
  fun `nav buttons open search and the player, unknown ids do nothing`() {
    assertEquals(FixtureRoute.Search, initial.onNav(TvFixtureCatalog.NAV_SEARCH).backStack.current)
    assertEquals(FixtureRoute.Player, initial.onNav(TvFixtureCatalog.NAV_PLAYER).backStack.current)
    assertSame(initial, initial.onNav("nav_unknown"))
  }

  @Test
  fun `opening a card shows its detail and sets the status`() {
    val detail = initial.openCard("card_featured_05")
    assertEquals(FixtureRoute.Detail("card_featured_05"), detail.backStack.current)
    assertEquals("Selected Featured 05", detail.status)
    assertSame(initial, initial.openCard("card_missing"))
  }

  @Test
  fun `focus line follows the focused card`() {
    assertEquals("Focused: none", initial.focus)
    assertEquals("Focused: Shows 09", initial.cardFocused("card_shows_09").focus)
    assertSame(initial, initial.cardFocused("card_missing"))
  }

  @Test
  fun `detail play opens the player and back unwinds to browse`() {
    val player = initial.openCard("card_movies_01").openPlayer()
    assertEquals(FixtureRoute.Player, player.backStack.current)
    val browse = player.back().back()
    assertEquals(FixtureRoute.Browse, browse.backStack.current)
    assertFalse(browse.backStack.canPop)
    assertEquals(browse, browse.back())
  }

  @Test
  fun `query drives search results and summary`() {
    val searched = initial.onNav(TvFixtureCatalog.NAV_SEARCH).queryChanged("featured 0")
    assertEquals(9, searched.results.size)
    assertEquals("9 results", searched.searchSummary)
    assertEquals("Type to search", initial.searchSummary)
  }

  @Test
  fun `saved state round trips and malformed input restores the initial state`() {
    val state = initial.openCard("card_shows_02").cardFocused("card_shows_02").queryChanged("shows")
    assertEquals(state, FixtureState.fromSaved(state.toSaved()))
    assertEquals(FixtureState(), FixtureState.fromSaved(listOf("bad")))
    assertEquals(
      FixtureBackStack(),
      FixtureState.fromSaved(listOf(listOf("detail/card_gone"), "s", "f", "q")).backStack,
    )
  }
}
