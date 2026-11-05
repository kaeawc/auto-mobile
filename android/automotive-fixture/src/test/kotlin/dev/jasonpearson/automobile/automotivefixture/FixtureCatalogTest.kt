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
  fun `template surfaces stay within the strictest host limits`() {
    // Hosts cap list and grid templates at six items and panes at four rows.
    assertTrue(FixtureCatalog.listTemplateRows.size <= 6)
    assertTrue(FixtureCatalog.gridItems.size <= 6)
    assertTrue(FixtureCatalog.paneRows.size <= 4)
    assertTrue(FixtureCatalog.pois.size <= 6)
    assertEquals(
      listOf("template_list", "template_grid", "template_pane", "template_navigation"),
      FixtureCatalog.templateMenu.map { it.id },
    )
  }
}
