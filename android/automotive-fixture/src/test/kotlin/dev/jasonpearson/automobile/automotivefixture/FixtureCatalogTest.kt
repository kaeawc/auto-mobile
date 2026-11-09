package dev.jasonpearson.automobile.automotivefixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FixtureCatalogTest {
  @Test
  fun `home list opens with the parked-only row then numbered rows`() {
    val rows = FixtureCatalog.homeRows
    assertEquals(FixtureCatalog.HOME_ROW_COUNT + 1, rows.size)
    assertEquals("Open parked-only screen", rows.first().title)
    assertEquals("Row 01", rows[1].title)
    assertEquals("Row 20", rows.last().title)
  }

  @Test
  fun `only the parked-only row routes to the parked-only activity`() {
    val destinations = FixtureCatalog.homeRows.map(FixtureCatalog::destinationFor)
    assertEquals(HomeDestination.PARKED_ONLY, destinations.first())
    assertTrue(destinations.drop(1).all { it == HomeDestination.SELECT })
  }

  @Test
  fun `selection status names the selected row`() {
    assertEquals("Nothing selected", FixtureCatalog.selectionStatus(null))
    assertEquals("Selected Row 07", FixtureCatalog.selectionStatus(FixtureCatalog.homeRows[7]))
  }

  @Test
  fun `every element id and title is unique within its surface`() {
    val surfaces =
      listOf(
        FixtureCatalog.homeRows,
        FixtureCatalog.templateMenu,
        FixtureCatalog.listTemplateRows,
        FixtureCatalog.longListTemplateRows,
        FixtureCatalog.gridItems,
        FixtureCatalog.paneRows,
      )
    surfaces.forEach { rows ->
      assertEquals(rows.size, rows.map { it.id }.toSet().size)
      assertEquals(rows.size, rows.map { it.title }.toSet().size)
    }
    assertEquals(FixtureCatalog.pois.size, FixtureCatalog.pois.map { it.id }.toSet().size)
  }

  @Test
  fun `long list has thirty deterministic rows and a menu entry`() {
    val rows = FixtureCatalog.longListTemplateRows
    assertEquals(30, rows.size)
    assertEquals("List long row 01", rows.first().title)
    assertEquals("List long row 30", rows.last().title)
    rows.forEachIndexed { index, row ->
      val number = (index + 1).toString().padStart(2, '0')
      assertEquals(
        FixtureRow("list_long_row_$number", "List long row $number", "List long detail $number"),
        row,
      )
    }
    assertEquals(
      FixtureRow("template_list_long", "List 30", "Thirty fixed rows"),
      FixtureCatalog.templateMenu.last(),
    )
    assertEquals(5, FixtureCatalog.templateMenu.size)
  }

  @Test
  fun `short template surfaces stay within the strictest host limits`() {
    // Keep the original short surfaces within six items and panes within four rows.
    // List 30 deliberately exercises template content beyond a host's visible row limit.
    assertTrue(FixtureCatalog.listTemplateRows.size <= 6)
    assertTrue(FixtureCatalog.gridItems.size <= 6)
    assertTrue(FixtureCatalog.paneRows.size <= 4)
    assertTrue(FixtureCatalog.pois.size <= 6)
    assertEquals(
      listOf(
        "template_list",
        "template_grid",
        "template_pane",
        "template_navigation",
        "template_list_long",
      ),
      FixtureCatalog.templateMenu.map { it.id },
    )
  }
}
