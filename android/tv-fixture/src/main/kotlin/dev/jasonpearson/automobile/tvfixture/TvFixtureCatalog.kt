package dev.jasonpearson.automobile.tvfixture

/** One card with a stable id, title and detail text. */
data class FixtureCard(val id: String, val title: String, val detail: String)

/** One browse row: a title above a horizontally scrolling list of cards. */
data class FixtureRow(val id: String, val title: String, val cards: List<FixtureCard>)

/** One player track. Duration is fixed so seek results are exact. */
data class FixtureTrack(val id: String, val title: String, val durationSeconds: Int)

/**
 * Every piece of text and every id the fixture shows. Checks match on these exact strings, so
 * changing one is a contract change for the TV smoke run and the focus regression tests.
 */
object TvFixtureCatalog {
  const val APP_TITLE = "AutoMobile TV"

  /** More cards than a 1080p row shows at once, so D-pad right must reveal the rest. */
  const val CARDS_PER_ROW = 12

  const val STATUS_READY = "Ready"
  const val FOCUS_NONE = "Focused: none"

  const val NAV_SEARCH = "nav_search"
  const val NAV_PLAYER = "nav_player"
  const val NAV_SEARCH_LABEL = "Search"
  const val NAV_PLAYER_LABEL = "Player"

  const val SEARCH_HINT = "Search titles"
  const val SEARCH_PROMPT = "Type to search"
  const val SEARCH_EMPTY = "No results"

  const val PLAY_LABEL = "Play"

  /** Seconds one fast-forward or rewind moves the player. */
  const val SEEK_STEP_SECONDS = 10

  val rows: List<FixtureRow> =
    listOf(row("featured", "Featured"), row("movies", "Movies"), row("shows", "Shows"))

  val cards: List<FixtureCard> = rows.flatMap { it.cards }

  val tracks: List<FixtureTrack> =
    listOf(
      FixtureTrack("track_01", "Opening Titles", 180),
      FixtureTrack("track_02", "Main Feature", 600),
      FixtureTrack("track_03", "End Credits", 120),
    )

  fun card(id: String?): FixtureCard? = cards.firstOrNull { it.id == id }

  /** Cards whose title contains [query], ignoring case. A blank query matches nothing. */
  fun search(query: String): List<FixtureCard> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    return cards.filter { it.title.contains(needle, ignoreCase = true) }
  }

  fun searchSummary(query: String, results: List<FixtureCard>): String =
    when {
      query.isBlank() -> SEARCH_PROMPT
      results.isEmpty() -> SEARCH_EMPTY
      results.size == 1 -> "1 result"
      else -> "${results.size} results"
    }

  fun selectedStatus(card: FixtureCard): String = "Selected ${card.title}"

  fun focusedStatus(card: FixtureCard): String = "Focused: ${card.title}"

  private fun row(key: String, title: String): FixtureRow =
    FixtureRow(
      id = "row_$key",
      title = title,
      cards =
        (1..CARDS_PER_ROW).map { index ->
          val number = index.toString().padStart(2, '0')
          FixtureCard("card_${key}_$number", "$title $number", "Detail for $title $number")
        },
    )
}
