package dev.jasonpearson.automobile.tvfixture

/** A fixture screen. Routes are strings so the back stack survives a saved-state round trip. */
sealed interface FixtureRoute {
  val route: String

  data object Browse : FixtureRoute {
    override val route = "browse"
  }

  data object Search : FixtureRoute {
    override val route = "search"
  }

  data object Player : FixtureRoute {
    override val route = "player"
  }

  data class Detail(val cardId: String) : FixtureRoute {
    override val route = "$DETAIL_PREFIX$cardId"
  }

  companion object {
    private const val DETAIL_PREFIX = "detail/"

    /** Unknown routes and unknown cards resolve to null so a stale saved stack falls back. */
    fun parse(route: String): FixtureRoute? =
      when {
        route == Browse.route -> Browse
        route == Search.route -> Search
        route == Player.route -> Player
        route.startsWith(DETAIL_PREFIX) ->
          route
            .removePrefix(DETAIL_PREFIX)
            .takeIf { TvFixtureCatalog.card(it) != null }
            ?.let(::Detail)
        else -> null
      }
  }
}

/** An immutable back stack whose bottom entry is always [FixtureRoute.Browse]. */
data class FixtureBackStack(val entries: List<FixtureRoute> = listOf(FixtureRoute.Browse)) {
  val current: FixtureRoute
    get() = entries.last()

  val canPop: Boolean
    get() = entries.size > 1

  fun push(route: FixtureRoute): FixtureBackStack =
    if (route == current) this else copy(entries = entries + route)

  fun pop(): FixtureBackStack = if (canPop) copy(entries = entries.dropLast(1)) else this

  fun toRoutes(): List<String> = entries.map { it.route }

  companion object {
    fun fromRoutes(routes: List<String>): FixtureBackStack {
      val parsed = routes.mapNotNull(FixtureRoute::parse).dropWhile { it != FixtureRoute.Browse }
      return if (parsed.isEmpty()) FixtureBackStack() else FixtureBackStack(parsed)
    }
  }
}
