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
    )

  /** Six rows: within the list-template row limit on every host. */
  val listTemplateRows: List<FixtureRow> =
    (1..6).map { FixtureRow("list_row_$it", "List row $it", "List detail $it") }

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
      FixturePoi("poi_charging", "Fixture Charging Station", "1 Fixture Way", 37.4220, -122.0841),
      FixturePoi("poi_cafe", "Fixture Cafe", "2 Fixture Way", 37.4225, -122.0850),
      FixturePoi("poi_parking", "Fixture Parking", "3 Fixture Way", 37.4230, -122.0860),
      FixturePoi("poi_park", "Fixture Park", "4 Fixture Way", 37.4235, -122.0870),
    )
}
