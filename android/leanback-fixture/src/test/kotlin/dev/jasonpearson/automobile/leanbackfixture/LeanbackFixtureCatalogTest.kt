package dev.jasonpearson.automobile.leanbackfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LeanbackFixtureCatalogTest {
  @Test
  fun `rows have fixed headers and twelve cards each`() {
    assertEquals(
      listOf("Featured", "Movies", "Shows"),
      LeanbackFixtureCatalog.rows.map { it.title },
    )
    assertEquals(listOf(0L, 1L, 2L), LeanbackFixtureCatalog.rows.map { it.headerId })
    LeanbackFixtureCatalog.rows.forEach {
      assertEquals(LeanbackFixtureCatalog.CARDS_PER_ROW, it.cards.size)
    }
  }

  @Test
  fun `card ids are unique and stable`() {
    val ids = LeanbackFixtureCatalog.cards.map { it.id }
    assertEquals(ids.size, ids.toSet().size)
    assertEquals("card_featured_01", ids.first())
    assertEquals("card_shows_12", ids.last())
    assertEquals("Movies 11", LeanbackFixtureCatalog.card("card_movies_11")?.title)
    assertNull(LeanbackFixtureCatalog.card("card_movies_00"))
  }

  @Test
  fun `detail lines come from the card, with a fixed fallback for unknown ids`() {
    assertEquals(
      "Shows 04" to "Detail for Shows 04",
      LeanbackFixtureCatalog.detailLines("card_shows_04"),
    )
    assertEquals("Unknown card" to "card_x", LeanbackFixtureCatalog.detailLines("card_x"))
    assertEquals("Unknown card" to "", LeanbackFixtureCatalog.detailLines(null))
  }
}
