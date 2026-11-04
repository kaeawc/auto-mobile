package dev.jasonpearson.automobile.wearfixture

/** A fixture screen. Routes are strings so the back stack survives a saved-state round trip. */
sealed interface FixtureRoute {
  val route: String

  data object Home : FixtureRoute {
    override val route = "home"
  }

  data class Detail(val itemId: String) : FixtureRoute {
    override val route = "$DETAIL_PREFIX$itemId"
  }

  data object Picker : FixtureRoute {
    override val route = "picker"
  }

  data object Dismiss : FixtureRoute {
    override val route = "dismiss"
  }

  companion object {
    private const val DETAIL_PREFIX = "detail/"

    /** Unknown routes and unknown items resolve to null so a stale saved stack falls back home. */
    fun parse(route: String): FixtureRoute? =
      when {
        route == Home.route -> Home
        route == Picker.route -> Picker
        route == Dismiss.route -> Dismiss
        route.startsWith(DETAIL_PREFIX) ->
          route
            .removePrefix(DETAIL_PREFIX)
            .takeIf { WearFixtureCatalog.item(it) != null }
            ?.let(::Detail)
        else -> null
      }
  }
}

/** An immutable back stack whose bottom entry is always [FixtureRoute.Home]. */
data class FixtureBackStack(val entries: List<FixtureRoute> = listOf(FixtureRoute.Home)) {
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
      val parsed = routes.mapNotNull(FixtureRoute::parse).dropWhile { it != FixtureRoute.Home }
      return if (parsed.isEmpty()) FixtureBackStack() else FixtureBackStack(parsed)
    }
  }
}
