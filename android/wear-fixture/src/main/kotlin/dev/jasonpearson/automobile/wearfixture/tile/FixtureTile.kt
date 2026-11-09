package dev.jasonpearson.automobile.wearfixture.tile

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.TileBuilders
import dev.jasonpearson.automobile.wearfixture.LaunchRequest
import dev.jasonpearson.automobile.wearfixture.MainActivity
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog

/** The fixture tile: a title and one clickable that opens the featured item's detail screen. */
object FixtureTile {
  const val RESOURCES_VERSION = "1"

  fun tile(packageName: String): TileBuilders.Tile =
    TileBuilders.Tile.Builder()
      .setResourcesVersion(RESOURCES_VERSION)
      .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout(packageName)))
      .build()

  fun resources(): ResourceBuilders.Resources =
    ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build()

  fun openItemAction(packageName: String): ActionBuilders.LaunchAction =
    ActionBuilders.LaunchAction.Builder()
      .setAndroidActivity(
        ActionBuilders.AndroidActivity.Builder()
          .setPackageName(packageName)
          .setClassName(MainActivity::class.java.name)
          .addKeyToExtraMapping(
            LaunchRequest.EXTRA_ITEM_ID,
            ActionBuilders.AndroidStringExtra.Builder()
              .setValue(WearFixtureCatalog.FEATURED_ITEM_ID)
              .build(),
          )
          .build(),
      )
      .build()

  private fun layout(packageName: String): LayoutElementBuilders.LayoutElement {
    val featured = checkNotNull(WearFixtureCatalog.item(WearFixtureCatalog.FEATURED_ITEM_ID))
    val clickable =
      ModifiersBuilders.Clickable.Builder()
        .setId(WearFixtureCatalog.TILE_CLICKABLE_ID)
        .setOnClick(openItemAction(packageName))
        .build()
    return LayoutElementBuilders.Box.Builder()
      .setWidth(DimensionBuilders.expand())
      .setHeight(DimensionBuilders.expand())
      .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(clickable).build())
      .addContent(
        LayoutElementBuilders.Column.Builder()
          .addContent(text(WearFixtureCatalog.TILE_TITLE))
          .addContent(text(WearFixtureCatalog.tileLabel(featured)))
          .build(),
      )
      .build()
  }

  private fun text(value: String): LayoutElementBuilders.Text =
    LayoutElementBuilders.Text.Builder().setText(value).build()
}
