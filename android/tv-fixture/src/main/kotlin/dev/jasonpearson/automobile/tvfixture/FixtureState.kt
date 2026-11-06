package dev.jasonpearson.automobile.tvfixture

/**
 * Everything the fixture UI shows besides the player. Each transition is a pure function, so
 * navigation, the status lines and search are tested without Compose.
 */
data class FixtureState(
  val backStack: FixtureBackStack = FixtureBackStack(),
  val status: String = TvFixtureCatalog.STATUS_READY,
  val focus: String = TvFixtureCatalog.FOCUS_NONE,
  val query: String = "",
) {
  val results: List<FixtureCard>
    get() = TvFixtureCatalog.search(query)

  val searchSummary: String
    get() = TvFixtureCatalog.searchSummary(query, results)

  /** The state after a browse navigation button, or this state for an unknown id. */
  fun onNav(navId: String): FixtureState =
    when (navId) {
      TvFixtureCatalog.NAV_SEARCH -> push(FixtureRoute.Search)
      TvFixtureCatalog.NAV_PLAYER -> push(FixtureRoute.Player)
      else -> this
    }

  /** Opens a card's detail screen; unknown ids leave the state unchanged. */
  fun openCard(cardId: String): FixtureState {
    val card = TvFixtureCatalog.card(cardId) ?: return this
    return push(FixtureRoute.Detail(card.id)).copy(status = TvFixtureCatalog.selectedStatus(card))
  }

  fun cardFocused(cardId: String): FixtureState {
    val card = TvFixtureCatalog.card(cardId) ?: return this
    return copy(focus = TvFixtureCatalog.focusedStatus(card))
  }

  fun openPlayer(): FixtureState = push(FixtureRoute.Player)

  fun queryChanged(value: String): FixtureState = copy(query = value)

  fun back(): FixtureState = copy(backStack = backStack.pop())

  /** Bundle-safe values for saved instance state. */
  fun toSaved(): List<Any> = listOf(ArrayList(backStack.toRoutes()), status, focus, query)

  private fun push(route: FixtureRoute): FixtureState = copy(backStack = backStack.push(route))

  companion object {
    private const val SAVED_SIZE = 4

    /** Restores [toSaved] output; anything malformed restores the initial state. */
    fun fromSaved(saved: List<Any?>): FixtureState {
      if (saved.size != SAVED_SIZE) return FixtureState()
      val routes = (saved[0] as? List<*>)?.takeIf { list -> list.all { it is String } }
      val texts = saved.drop(1).filterIsInstance<String>()
      if (routes == null || texts.size != SAVED_SIZE - 1) return FixtureState()
      val (status, focus, query) = texts
      return FixtureState(
        backStack = FixtureBackStack.fromRoutes(routes.filterIsInstance<String>()),
        status = status,
        focus = focus,
        query = query,
      )
    }
  }
}
