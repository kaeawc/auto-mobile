package dev.jasonpearson.automobile.tvfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TvFixtureCatalogTest {
  @Test
  fun `rows and cards have fixed, unique ids`() {
    assertEquals(
      listOf("row_featured", "row_movies", "row_shows"),
      TvFixtureCatalog.rows.map { it.id },
    )
    TvFixtureCatalog.rows.forEach { assertEquals(TvFixtureCatalog.CARDS_PER_ROW, it.cards.size) }
    val ids = TvFixtureCatalog.cards.map { it.id }
    assertEquals(ids.size, ids.toSet().size)
    assertEquals("card_movies_03", TvFixtureCatalog.rows[1].cards[2].id)
    assertEquals("Movies 03", TvFixtureCatalog.rows[1].cards[2].title)
    assertEquals("Detail for Shows 12", TvFixtureCatalog.card("card_shows_12")?.detail)
  }

  @Test
  fun `unknown card ids resolve to null`() {
    assertNull(TvFixtureCatalog.card("card_movies_13"))
    assertNull(TvFixtureCatalog.card(null))
  }

  @Test
  fun `search matches titles ignoring case and surrounding spaces`() {
    assertEquals(
      listOf("Movies 10", "Movies 11", "Movies 12"),
      TvFixtureCatalog.search("  movies 1 ").map { it.title },
    )
    assertEquals(TvFixtureCatalog.CARDS_PER_ROW, TvFixtureCatalog.search("SHOWS").size)
  }

  @Test
  fun `blank and unmatched queries return no results with distinct summaries`() {
    assertTrue(TvFixtureCatalog.search("   ").isEmpty())
    assertEquals("Type to search", TvFixtureCatalog.searchSummary("  ", emptyList()))
    assertEquals(
      "No results",
      TvFixtureCatalog.searchSummary("zzz", TvFixtureCatalog.search("zzz")),
    )
    assertEquals(
      "1 result",
      TvFixtureCatalog.searchSummary("07", TvFixtureCatalog.search("Featured 07")),
    )
    assertEquals("3 results", TvFixtureCatalog.searchSummary("07", TvFixtureCatalog.search("07")))
  }
}
