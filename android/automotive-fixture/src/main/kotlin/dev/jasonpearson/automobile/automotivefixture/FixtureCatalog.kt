package dev.jasonpearson.automobile.automotivefixture

/** One element with stable id and text, shared by the activities and the templates. */
data class FixtureRow(val id: String, val title: String, val subtitle: String)

/** A point of interest for the navigation template. Coordinates are fixed, never looked up. */
data class FixturePoi(
  val id: String,
  val name: String,
  val address: String,
  val latitude: Double,
  val longitude: Double,
  /** Fixed distance shown by the navigation template; never computed from a location. */
  val distanceKm: Double,
)

/** Where a home-list row leads. */
enum class HomeDestination {
  PARKED_ONLY,
  SELECT,
}

/**
 * Every piece of text the fixture shows. Checks match on these exact strings, so changing one is a
 * contract change for the automotive smoke run.
 */
object FixtureCatalog {
  const val PARKED_ONLY_ROW_ID = "row_parked_only"
  const val HOME_ROW_COUNT = 20

  val parkedOnlyRow =
    FixtureRow(PARKED_ONLY_ROW_ID, "Open parked-only screen", "Blocked while driving")

  /** The parked-only entry first, so it is visible without scrolling, then numbered rows. */
  val homeRows: List<FixtureRow> =
    listOf(parkedOnlyRow) +
      (1..HOME_ROW_COUNT).map { index ->
        val number = index.toString().padStart(2, '0')
        FixtureRow("row_$number", "Row $number", "Fixture row $number")
      }

  fun destinationFor(row: FixtureRow): HomeDestination =
    if (row.id == PARKED_ONLY_ROW_ID) HomeDestination.PARKED_ONLY else HomeDestination.SELECT

  fun selectionStatus(row: FixtureRow?): String =
    if (row == null) "Nothing selected" else "Selected ${row.title}"

  /** Entries on the templated home screen, one per template under test. */
  val templateMenu: List<FixtureRow> =
    listOf(
      FixtureRow("template_list", "List template", "Six fixed rows"),
      FixtureRow("template_grid", "Grid template", "Six fixed tiles"),
      FixtureRow("template_pane", "Pane template", "Four fixed rows"),
      FixtureRow("template_navigation", "Navigation template", "Four fixed places"),
      FixtureRow("template_list_long", "List 30", "Thirty fixed rows"),
      FixtureRow("template_tabs", "Tab template", "Two tabs"),
      FixtureRow("template_refresh", "Refresh list", "Items change on tap"),
      FixtureRow("template_silent", "Silent change", "Template changes, pixels do not"),
      FixtureRow("template_restrictions", "Restrictions", "Shows the host content limits"),
    )

  /** Smallest list-template row limit any host applies; every menu page stays within it. */
  const val HOST_LIST_ROW_LIMIT = 6

  /** Entries per menu page; the remaining slot on a non-final page holds [menuMoreRow]. */
  const val MENU_PAGE_ENTRIES = HOST_LIST_ROW_LIMIT - 1

  const val MENU_MORE_ROW_ID = "template_menu_more"
  val menuMoreRow = FixtureRow(MENU_MORE_ROW_ID, "More templates", "Next page of templates")

  /** TabTemplate needs Car App API level 6; the manifest minimum is 1. */
  const val TAB_TEMPLATE_ID = "template_tabs"
  const val TAB_TEMPLATE_MIN_CAR_API = 6

  /** The menu entries a host at [carApiLevel] can open; the tab template is hidden below API 6. */
  fun menuEntries(carApiLevel: Int): List<FixtureRow> = templateMenu.filter {
    it.id != TAB_TEMPLATE_ID || carApiLevel >= TAB_TEMPLATE_MIN_CAR_API
  }

  fun menuPageCount(carApiLevel: Int): Int =
    (menuEntries(carApiLevel).size + MENU_PAGE_ENTRIES - 1) / MENU_PAGE_ENTRIES

  /** One menu page: up to [MENU_PAGE_ENTRIES] entries plus [menuMoreRow] when more pages follow. */
  fun menuPage(carApiLevel: Int, page: Int): List<FixtureRow> {
    val entries = menuEntries(carApiLevel)
    val start = page * MENU_PAGE_ENTRIES
    val rows = entries.drop(start).take(MENU_PAGE_ENTRIES)
    return if (start + MENU_PAGE_ENTRIES < entries.size) rows + menuMoreRow else rows
  }

  /** Tab titles, in order. Each tab's list has a different set of rows. */
  val tabTitles: List<String> = listOf("Tab One", "Tab Two")

  fun tabId(index: Int): String = "tab_${index + 1}"

  fun tabRows(index: Int): List<FixtureRow> =
    (1..3).map { FixtureRow("tab_${index + 1}_row_$it", "Tab ${index + 1} row $it", "Tab detail") }

  const val REFRESH_ACTION_TITLE = "Refresh items"

  /** The refreshing list's data rows after [revision] refreshes; the action row is separate. */
  fun refreshRows(revision: Int): List<FixtureRow> =
    (1..3).map { FixtureRow("refresh_row_$it", "Refresh item $it", "Refresh $revision") }

  const val SILENT_ACTION_TITLE = "Change without redrawing"
  const val SILENT_ROW_TITLE = "Silent row"
  const val SILENT_BASE_SUBTITLE = "Looks the same"

  /**
   * The silent row's subtitle after [revision] changes: the base text plus [revision] zero-width
   * spaces. The template differs on every revision while the rendered pixels stay identical.
   */
  fun silentSubtitle(revision: Int): String = SILENT_BASE_SUBTITLE + "\u200B".repeat(revision)

  const val RESTRICTIONS_ACTION_TITLE = "Re-read limits"

  /**
   * One line per host content limit, so the head unit shows what the host currently allows. A
   * driving restriction lowers these limits, which makes `restrict all` visible on screen.
   */
  fun restrictionRows(limits: Map<String, Int>): List<FixtureRow> = limits.map { (name, limit) ->
    FixtureRow("limit_${name.lowercase()}", "$name limit", limit.toString())
  }

  /** Six rows: within the list-template row limit on every host. */
  val listTemplateRows: List<FixtureRow> =
    (1..6).map { FixtureRow("list_row_$it", "List row $it", "List detail $it") }

  /** Thirty fixed rows to exercise long template snapshots, regardless of host truncation. */
  val longListTemplateRows: List<FixtureRow> =
    (1..30).map { index ->
      val number = index.toString().padStart(2, '0')
      FixtureRow("list_long_row_$number", "List long row $number", "List long detail $number")
    }

  val gridItems: List<FixtureRow> =
    (1..6).map { FixtureRow("grid_item_$it", "Tile $it", "Grid detail $it") }

  val paneRows: List<FixtureRow> =
    listOf(
      FixtureRow("pane_speed", "Speed", "0 km/h"),
      FixtureRow("pane_range", "Range", "420 km"),
      FixtureRow("pane_battery", "Battery", "80 percent"),
      FixtureRow("pane_cabin", "Cabin", "21 degrees"),
    )

  val pois: List<FixturePoi> =
    listOf(
      FixturePoi(
        "poi_charging",
        "Fixture Charging Station",
        "1 Fixture Way",
        37.4220,
        -122.0841,
        0.5,
      ),
      FixturePoi("poi_cafe", "Fixture Cafe", "2 Fixture Way", 37.4225, -122.0850, 1.2),
      FixturePoi("poi_parking", "Fixture Parking", "3 Fixture Way", 37.4230, -122.0860, 2.4),
      FixturePoi("poi_park", "Fixture Park", "4 Fixture Way", 37.4235, -122.0870, 3.8),
    )
}
