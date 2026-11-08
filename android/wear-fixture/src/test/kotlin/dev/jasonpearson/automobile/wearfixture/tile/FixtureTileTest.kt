package dev.jasonpearson.automobile.wearfixture.tile

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import dev.jasonpearson.automobile.wearfixture.LaunchRequest
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog
import org.junit.Assert.assertEquals
import org.junit.Test

class FixtureTileTest {
  private val packageName = "dev.jasonpearson.automobile.wearfixture"

  @Test
  fun `tile clickable opens the featured item in the fixture activity`() {
    val root =
      FixtureTile.tile(packageName).tileTimeline!!.timelineEntries.single().layout!!.root
        as LayoutElementBuilders.Box
    val clickable = root.modifiers!!.clickable!!
    assertEquals(WearFixtureCatalog.TILE_CLICKABLE_ID, clickable.id)

    val activity = (clickable.onClick as ActionBuilders.LaunchAction).androidActivity!!
    assertEquals(packageName, activity.packageName)
    assertEquals("dev.jasonpearson.automobile.wearfixture.MainActivity", activity.className)
    val extra = activity.keyToExtraMapping[LaunchRequest.EXTRA_ITEM_ID]
    assertEquals(
      WearFixtureCatalog.FEATURED_ITEM_ID,
      (extra as ActionBuilders.AndroidStringExtra).value,
    )
  }

  @Test
  fun `tile shows the title and the open label`() {
    val root =
      FixtureTile.tile(packageName).tileTimeline!!.timelineEntries.single().layout!!.root
        as LayoutElementBuilders.Box
    val column = root.contents.single() as LayoutElementBuilders.Column
    val texts = column.contents.map { (it as LayoutElementBuilders.Text).text!!.value }
    assertEquals(listOf("AutoMobile Tile", "Open Item 07"), texts)
  }

  @Test
  fun `tile and resources share one version`() {
    assertEquals(FixtureTile.RESOURCES_VERSION, FixtureTile.tile(packageName).resourcesVersion)
    assertEquals(FixtureTile.RESOURCES_VERSION, FixtureTile.resources().version)
  }
}
