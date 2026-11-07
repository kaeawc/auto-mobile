package dev.jasonpearson.automobile.leanbackfixture

/** One card with a stable id, title and detail text. */
data class FixtureCard(val id: String, val title: String, val detail: String)

/** One browse row: a header in the headers column and a row of cards. */
data class FixtureRow(val headerId: Long, val title: String, val cards: List<FixtureCard>)

/**
 * Every piece of text and every id the fixture shows. Checks match on these exact strings, so
 * changing one is a contract change for the TV smoke run and the focus regression tests.
 */
object LeanbackFixtureCatalog {
  const val BROWSE_TITLE = "AutoMobile Leanback"

  /** More cards than a 1080p row shows at once, so D-pad right must reveal the rest. */
  const val CARDS_PER_ROW = 12

  const val EXTRA_CARD_ID = "dev.jasonpearson.automobile.leanbackfixture.CARD_ID"
  const val MISSING_CARD_TITLE = "Unknown card"

  val rows: List<FixtureRow> =
    listOf(row(0, "featured", "Featured"), row(1, "movies", "Movies"), row(2, "shows", "Shows"))

  val cards: List<FixtureCard> = rows.flatMap { it.cards }

  fun card(id: String?): FixtureCard? = cards.firstOrNull { it.id == id }

  /** The title and text the detail screen shows for [id]; an unknown id shows a fixed fallback. */
  fun detailLines(id: String?): Pair<String, String> =
    card(id)?.let { it.title to it.detail } ?: (MISSING_CARD_TITLE to (id ?: ""))

  private fun row(headerId: Long, key: String, title: String): FixtureRow =
    FixtureRow(
      headerId = headerId,
      title = title,
      cards =
        (1..CARDS_PER_ROW).map { index ->
          val number = index.toString().padStart(2, '0')
          FixtureCard("card_${key}_$number", "$title $number", "Detail for $title $number")
        },
    )
}
