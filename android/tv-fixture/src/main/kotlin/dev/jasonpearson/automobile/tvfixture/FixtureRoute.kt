package dev.jasonpearson.automobile.tvfixture

/** A fixture screen. Routes are strings so the back stack survives a saved-state round trip. */
sealed interface FixtureRoute {
  val route: String

  /** The stable screen name this route reports to the AutoMobile SDK's navigation graph. */
  val screenName: String

  /** Navigation arguments reported with [screenName]. */
  val arguments: Map<String, String>
    get() = emptyMap()

  data object Browse : FixtureRoute {
    override val route = "browse"
    override val screenName = "BrowseDestination"
  }

  data object Search : FixtureRoute {
    override val route = "search"
    override val screenName = "SearchDestination"
  }

  data object Player : FixtureRoute {
    override val route = "player"
    override val screenName = "PlayerDestination"
  }

  data class Detail(val cardId: String) : FixtureRoute {
    override val route = "$DETAIL_PREFIX$cardId"
    override val screenName = "DetailDestination"
    override val arguments: Map<String, String>
      get() = mapOf("cardId" to cardId)
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
