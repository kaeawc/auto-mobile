package dev.jasonpearson.automobile.automotivefixture.car

import androidx.car.app.model.CarIcon
import androidx.car.app.model.Row
import dev.jasonpearson.automobile.automotivefixture.FixtureCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FixtureViewsTemplateTest {
  private fun rows(template: androidx.car.app.model.ListTemplate) =
    template.singleList!!.items.map { it as Row }

  @Test
  fun `refresh list has a clickable action row then changing item rows`() {
    var refreshed = 0
    val first = rows(refreshListTemplate(0) { refreshed++ })
    val second = rows(refreshListTemplate(1) {})

    assertEquals(FixtureCatalog.REFRESH_ACTION_TITLE, first[0].title.toString())
    assertNotNull(first[0].onClickDelegate)
    assertEquals(4, first.size)
    assertEquals("Refreshed 0 times", first[0].texts.single().toString())
    assertEquals("Refreshed 1 times", second[0].texts.single().toString())
    assertEquals("Refresh 0", first[1].texts.single().toString())
    assertEquals("Refresh 1", second[1].texts.single().toString())
  }

  @Test
  fun `tab template builds with both tabs and the active tab's rows`() {
    val icon = CarIcon.ALERT
    val second = tabTemplate(1, icon) {}

    assertEquals(FixtureCatalog.tabTitles, second.tabs.map { it.title.toString() })
    assertEquals(FixtureCatalog.tabId(1), second.activeTabContentId)
    val contents = second.tabContents.template as androidx.car.app.model.ListTemplate
    assertEquals(
      FixtureCatalog.tabRows(1).map { it.title },
      rows(contents).map { it.title.toString() },
    )
  }

  @Test
  fun `silent change template differs only in invisible characters`() {
    val first = rows(silentChangeTemplate(0) {})[1].texts.single().toString()
    val second = rows(silentChangeTemplate(2) {})[1].texts.single().toString()

    assertEquals(first, second.replace("\u200B", ""))
    assertEquals(FixtureCatalog.SILENT_BASE_SUBTITLE.length + 2, second.length)
  }

  @Test
  fun `restrictions template lists every limit after the action row`() {
    val template = restrictionsTemplate(linkedMapOf("List" to 6, "Pane" to 4)) {}
    val list = rows(template)

    assertEquals(FixtureCatalog.RESTRICTIONS_ACTION_TITLE, list[0].title.toString())
    assertEquals(listOf("List limit", "Pane limit"), list.drop(1).map { it.title.toString() })
    assertEquals(listOf("6", "4"), list.drop(1).map { it.texts.single().toString() })
  }
}
