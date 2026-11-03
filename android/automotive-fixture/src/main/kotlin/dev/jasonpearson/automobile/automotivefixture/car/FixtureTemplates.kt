package dev.jasonpearson.automobile.automotivefixture.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarLocation
import androidx.car.app.model.GridItem
import androidx.car.app.model.GridTemplate
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Metadata
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Place
import androidx.car.app.model.PlaceMarker
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.PlaceListNavigationTemplate
import androidx.core.graphics.drawable.IconCompat
import dev.jasonpearson.automobile.automotivefixture.FixtureCatalog
import dev.jasonpearson.automobile.automotivefixture.FixtureRow
import dev.jasonpearson.automobile.automotivefixture.R

private fun header(title: String, back: Boolean): Header =
  Header.Builder()
    .setTitle(title)
    .apply { if (back) setStartHeaderAction(Action.BACK) }
    .build()

private fun row(item: FixtureRow, onClick: (() -> Unit)? = null): Row =
  Row.Builder()
    .setTitle(item.title)
    .addText(item.subtitle)
    .apply { onClick?.let { setOnClickListener(it) } }
    .build()

/** Templated home: one row per template under test. */
class TemplateMenuScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val list = ItemList.Builder()
    FixtureCatalog.templateMenu.forEach { item ->
      list.addItem(row(item) { screenManager.push(screenFor(item.id)) })
    }
    return ListTemplate.Builder()
      .setHeader(header(TEMPLATE_HOME_TITLE, back = false))
      .setSingleList(list.build())
      .build()
  }

  private fun screenFor(id: String): Screen =
    when (id) {
      "template_grid" -> GridScreen(carContext)
      "template_pane" -> PaneScreen(carContext)
      "template_navigation" -> PoiNavigationScreen(carContext)
      else -> ListScreen(carContext)
    }

  companion object {
    const val TEMPLATE_HOME_TITLE = "AutoMobile Templates"
  }
}

/** Six fixed rows; tapping one opens [RowDetailScreen]. */
class ListScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val list = ItemList.Builder()
    FixtureCatalog.listTemplateRows.forEach { item ->
      list.addItem(row(item) { screenManager.push(RowDetailScreen(carContext, item)) })
    }
    return ListTemplate.Builder()
      .setHeader(header("List template", back = true))
      .setSingleList(list.build())
      .build()
  }
}

/** Six fixed tiles; tapping one opens [RowDetailScreen]. */
class GridScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val icon =
      CarIcon.Builder(IconCompat.createWithResource(carContext, R.drawable.ic_fixture)).build()
    val list = ItemList.Builder()
    FixtureCatalog.gridItems.forEach { item ->
      list.addItem(
        GridItem.Builder()
          .setTitle(item.title)
          .setText(item.subtitle)
          .setImage(icon)
          .setOnClickListener { screenManager.push(RowDetailScreen(carContext, item)) }
          .build()
      )
    }
    return GridTemplate.Builder()
      .setHeader(header("Grid template", back = true))
      .setSingleList(list.build())
      .build()
  }
}

/** Four fixed read-only rows. */
class PaneScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val pane = Pane.Builder()
    FixtureCatalog.paneRows.forEach { pane.addRow(row(it)) }
    return PaneTemplate.Builder(pane.build()).setHeader(header("Pane template", back = true)).build()
  }
}

/** Shows the row or tile that was tapped, so a check can confirm the tap and then go back. */
class RowDetailScreen(carContext: CarContext, private val item: FixtureRow) : Screen(carContext) {
  override fun onGetTemplate(): Template =
    PaneTemplate.Builder(Pane.Builder().addRow(row(item)).build())
      .setHeader(header(item.title, back = true))
      .build()
}

/** Navigation place list with four fixed points of interest; no map is drawn. */
class PoiNavigationScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val list = ItemList.Builder()
    FixtureCatalog.pois.forEach { poi ->
      val place =
        Place.Builder(CarLocation.create(poi.latitude, poi.longitude))
          .setMarker(PlaceMarker.Builder().build())
          .build()
      list.addItem(
        Row.Builder()
          .setTitle(poi.name)
          .addText(poi.address)
          .setMetadata(Metadata.Builder().setPlace(place).build())
          .setOnClickListener {
            screenManager.push(
              RowDetailScreen(carContext, FixtureRow(poi.id, poi.name, poi.address))
            )
          }
          .build()
      )
    }
    return PlaceListNavigationTemplate.Builder()
      .setHeader(header("Navigation template", back = true))
      .setItemList(list.build())
      .build()
  }
}
