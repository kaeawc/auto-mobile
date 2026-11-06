package dev.jasonpearson.automobile.wearfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WearFixtureCatalogTest {
  @Test
  fun `list has thirty numbered items with stable ids and detail text`() {
    val items = WearFixtureCatalog.items
    assertEquals(WearFixtureCatalog.ITEM_COUNT, items.size)
    assertEquals(FixtureItem("item_01", "Item 01", "Detail for Item 01"), items.first())
    assertEquals(FixtureItem("item_30", "Item 30", "Detail for Item 30"), items.last())
  }

  @Test
  fun `ids and labels are unique across the home screen`() {
    val ids = WearFixtureCatalog.actions.map { it.id } + WearFixtureCatalog.items.map { it.id }
    val labels =
      WearFixtureCatalog.actions.map { it.label } + WearFixtureCatalog.items.map { it.title }
    assertEquals(ids.size, ids.toSet().size)
    assertEquals(labels.size, labels.toSet().size)
  }

  @Test
  fun `featured item exists so the tile and complication open a real detail screen`() {
    val featured = WearFixtureCatalog.item(WearFixtureCatalog.FEATURED_ITEM_ID)
    assertNotNull(featured)
    assertEquals("Open Item 07", WearFixtureCatalog.tileLabel(featured!!))
    assertNull(WearFixtureCatalog.item("item_99"))
    assertNull(WearFixtureCatalog.item(null))
  }

  @Test
  fun `notification actions map to status lines and unknown actions map to none`() {
    assertEquals(
      listOf("reply", "archive"),
      WearFixtureCatalog.notificationActions.map { it.id },
    )
    assertEquals(
      "Notification action: Reply",
      WearFixtureCatalog.notificationActionStatus("reply"),
    )
    assertEquals(
      "Notification action: Archive",
      WearFixtureCatalog.notificationActionStatus("archive"),
    )
    assertNull(WearFixtureCatalog.notificationActionStatus("snooze"))
    assertNull(WearFixtureCatalog.notificationActionStatus(null))
  }

  @Test
  fun `picker values run from Level 0 to Level 11`() {
    assertEquals("Level 0", WearFixtureCatalog.pickerValues.first())
    assertEquals("Level 11", WearFixtureCatalog.pickerValues.last())
    assertEquals("Picked Level 3", WearFixtureCatalog.pickerStatus("Level 3"))
  }
}
