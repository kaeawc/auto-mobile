package dev.jasonpearson.automobile.automotivefixture.car

import android.text.SpannableString
import android.text.Spanned
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarLocation
import androidx.car.app.model.Distance
import androidx.car.app.model.DistanceSpan
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
import androidx.car.app.model.Tab
import androidx.car.app.model.TabContents
import androidx.car.app.model.TabTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.PlaceListNavigationTemplate
import androidx.core.graphics.drawable.IconCompat
import dev.jasonpearson.automobile.automotivefixture.FixtureCatalog
import dev.jasonpearson.automobile.automotivefixture.FixturePoi
import dev.jasonpearson.automobile.automotivefixture.FixtureRow
import dev.jasonpearson.automobile.automotivefixture.R

private fun header(title: String, back: Boolean): Header =
  Header.Builder().setTitle(title).apply { if (back) setStartHeaderAction(Action.BACK) }.build()

private fun row(item: FixtureRow, onClick: (() -> Unit)? = null): Row =
  Row.Builder()
    .setTitle(item.title)
    .addText(item.subtitle)
    .apply { onClick?.let { setOnClickListener(it) } }
    .build()

/**
 * Templated home: one row per template under test, paged so no page exceeds the host's smallest
 * list limit. A non-final page ends with a "More templates" row; later pages have a back action.
 */
class TemplateMenuScreen(carContext: CarContext, private val page: Int = 0) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val list = ItemList.Builder()
    FixtureCatalog.menuPage(carContext.carAppApiLevel, page).forEach { item ->
      list.addItem(
        row(item) {
          if (item.id == FixtureCatalog.MENU_MORE_ROW_ID) {
            screenManager.push(TemplateMenuScreen(carContext, page + 1))
          } else {
            screenManager.push(screenFor(item.id))
          }
        },
      )
    }
    return CarTemplateRecorderFactory.recorder.record(
      this,
      ListTemplate.Builder()
        .setHeader(header(TEMPLATE_HOME_TITLE, back = page > 0))
        .setSingleList(list.build())
        .build(),
    )
  }

  private fun screenFor(id: String): Screen =
    when (id) {
      "template_grid" -> GridScreen(carContext)
      "template_pane" -> PaneScreen(carContext)
      "template_navigation" -> PoiNavigationScreen(carContext)
      "template_list_long" -> LongListScreen(carContext)
      FixtureCatalog.TAB_TEMPLATE_ID -> TabScreen(carContext)
      "template_refresh" -> RefreshListScreen(carContext)
      "template_silent" -> SilentChangeScreen(carContext)
      "template_restrictions" -> RestrictionsScreen(carContext)
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
    return CarTemplateRecorderFactory.recorder.record(
      this,
      ListTemplate.Builder()
        .setHeader(header("List template", back = true))
        .setSingleList(list.build())
        .build(),
    )
  }
}

/** Thirty fixed rows; a host may render fewer than the recorded template contains. */
class LongListScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template =
    CarTemplateRecorderFactory.recorder.record(
      this,
      longListTemplate(FixtureCatalog.longListTemplateRows) { item ->
        screenManager.push(RowDetailScreen(carContext, item))
      },
    )
}

/** Pure builder so the full long list can be checked without a templates host. */
fun longListTemplate(rows: List<FixtureRow>, onClick: (FixtureRow) -> Unit): ListTemplate {
  val list = ItemList.Builder()
  rows.forEach { item -> list.addItem(row(item) { onClick(item) }) }
  return ListTemplate.Builder()
    .setHeader(header("List 30", back = true))
    .setSingleList(list.build())
    .build()
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
          .build(),
      )
    }
    return CarTemplateRecorderFactory.recorder.record(
      this,
      GridTemplate.Builder()
        .setHeader(header("Grid template", back = true))
        .setSingleList(list.build())
        .build(),
    )
  }
}

/** Four fixed read-only rows. */
class PaneScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val pane = Pane.Builder()
    FixtureCatalog.paneRows.forEach { pane.addRow(row(it)) }
    return CarTemplateRecorderFactory.recorder.record(
      this,
      PaneTemplate.Builder(pane.build()).setHeader(header("Pane template", back = true)).build(),
    )
  }
}

/** Shows the row or tile that was tapped, so a check can confirm the tap and then go back. */
class RowDetailScreen(carContext: CarContext, private val item: FixtureRow) : Screen(carContext) {
  override fun onGetTemplate(): Template =
    CarTemplateRecorderFactory.recorder.record(
      this,
      PaneTemplate.Builder(Pane.Builder().addRow(row(item)).build())
        .setHeader(header(item.title, back = true))
        .build(),
    )
}

/** Navigation place list with four fixed points of interest; no map is drawn. */
class PoiNavigationScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template =
    CarTemplateRecorderFactory.recorder.record(
      this,
      poiPlaceListTemplate(FixtureCatalog.pois) { poi ->
        screenManager.push(RowDetailScreen(carContext, FixtureRow(poi.id, poi.name, poi.address)))
      },
    )
}

/**
 * The place list behind [PoiNavigationScreen]. Every non-browsable row in a place list must carry a
 * [DistanceSpan] (or the builder throws), so each address line leads with the fixed distance.
 */
fun poiPlaceListTemplate(
  pois: List<FixturePoi>,
  onClick: (FixturePoi) -> Unit,
): PlaceListNavigationTemplate {
  val list = ItemList.Builder()
  pois.forEach { poi ->
    val place =
      Place.Builder(CarLocation.create(poi.latitude, poi.longitude))
        .setMarker(PlaceMarker.Builder().build())
        .build()
    val text = SpannableString("$DISTANCE_PLACEHOLDER · ${poi.address}")
    text.setSpan(
      DistanceSpan.create(Distance.create(poi.distanceKm, Distance.UNIT_KILOMETERS)),
      0,
      DISTANCE_PLACEHOLDER.length,
      Spanned.SPAN_INCLUSIVE_INCLUSIVE,
    )
    list.addItem(
      Row.Builder()
        .setTitle(poi.name)
        .addText(text)
        .setMetadata(Metadata.Builder().setPlace(place).build())
        .setOnClickListener { onClick(poi) }
        .build(),
    )
  }
  return PlaceListNavigationTemplate.Builder()
    .setHeader(header("Navigation template", back = true))
    .setItemList(list.build())
    .build()
}

// The host replaces the spanned character with the formatted distance.
private const val DISTANCE_PLACEHOLDER = " "

/** Two tabs, each with its own rows; selecting a tab changes the template, not the screen. */
class TabScreen(carContext: CarContext) : Screen(carContext) {
  private var active = 0

  override fun onGetTemplate(): Template {
    val icon =
      CarIcon.Builder(IconCompat.createWithResource(carContext, R.drawable.ic_fixture)).build()
    return CarTemplateRecorderFactory.recorder.record(
      this,
      tabTemplate(active, icon) { tabContentId ->
        active = FixtureCatalog.tabTitles.indices.first { FixtureCatalog.tabId(it) == tabContentId }
        invalidate()
      },
    )
  }
}

/** Pure builder so the tab template's host constraints are checked without a templates host. */
fun tabTemplate(active: Int, icon: CarIcon, onTabSelected: (String) -> Unit): TabTemplate {
  val builder =
    TabTemplate.Builder(
        object : TabTemplate.TabCallback {
          override fun onTabSelected(tabContentId: String) = onTabSelected(tabContentId)
        },
      )
      // A TabTemplate's header action must be the app icon; Action.BACK is rejected.
      .setHeaderAction(Action.APP_ICON)
  FixtureCatalog.tabTitles.forEachIndexed { index, title ->
    builder.addTab(
      Tab.Builder().setTitle(title).setIcon(icon).setContentId(FixtureCatalog.tabId(index)).build(),
    )
  }
  val list = ItemList.Builder()
  FixtureCatalog.tabRows(active).forEach { list.addItem(row(it)) }
  return builder
    .setTabContents(
      TabContents.Builder(ListTemplate.Builder().setSingleList(list.build()).build()).build(),
    )
    .setActiveTabContentId(FixtureCatalog.tabId(active))
    .build()
}

/** A list whose rows change each time its first row is tapped. */
class RefreshListScreen(carContext: CarContext) : Screen(carContext) {
  private var revision = 0

  override fun onGetTemplate(): Template =
    CarTemplateRecorderFactory.recorder.record(
      this,
      refreshListTemplate(revision) {
        revision++
        invalidate()
      },
    )
}

/** Pure builder so the refreshing list can be checked without a templates host. */
fun refreshListTemplate(revision: Int, onRefresh: () -> Unit): ListTemplate {
  val list = ItemList.Builder()
  list.addItem(
    Row.Builder()
      .setTitle(FixtureCatalog.REFRESH_ACTION_TITLE)
      .addText("Refreshed $revision times")
      .setOnClickListener(onRefresh)
      .build(),
  )
  FixtureCatalog.refreshRows(revision).forEach { list.addItem(row(it)) }
  return ListTemplate.Builder()
    .setHeader(header("Refresh list", back = true))
    .setSingleList(list.build())
    .build()
}

/**
 * Tapping the action row changes only invisible characters in another row, so the template content
 * differs while the head unit draws the same pixels.
 */
class SilentChangeScreen(carContext: CarContext) : Screen(carContext) {
  private var revision = 0

  override fun onGetTemplate(): Template =
    CarTemplateRecorderFactory.recorder.record(
      this,
      silentChangeTemplate(revision) {
        revision++
        invalidate()
      },
    )
}

fun silentChangeTemplate(revision: Int, onChange: () -> Unit): ListTemplate {
  val list = ItemList.Builder()
  list.addItem(
    Row.Builder().setTitle(FixtureCatalog.SILENT_ACTION_TITLE).setOnClickListener(onChange).build(),
  )
  list.addItem(
    Row.Builder()
      .setTitle(FixtureCatalog.SILENT_ROW_TITLE)
      .addText(FixtureCatalog.silentSubtitle(revision))
      .build(),
  )
  return ListTemplate.Builder()
    .setHeader(header("Silent change", back = true))
    .setSingleList(list.build())
    .build()
}

/** Shows the host's current content limits, which a driving restriction lowers. */
class RestrictionsScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template {
    val manager = carContext.getCarService(ConstraintManager::class.java)
    val limits =
      linkedMapOf(
        "List" to manager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST),
        "Grid" to manager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_GRID),
        "Pane" to manager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_PANE),
        "Place list" to manager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_PLACE_LIST),
        "Route list" to manager.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_ROUTE_LIST),
      )
    return CarTemplateRecorderFactory.recorder.record(
      this,
      restrictionsTemplate(limits) { invalidate() },
    )
  }
}

fun restrictionsTemplate(limits: Map<String, Int>, onReread: () -> Unit): ListTemplate {
  val list = ItemList.Builder()
  list.addItem(
    Row.Builder()
      .setTitle(FixtureCatalog.RESTRICTIONS_ACTION_TITLE)
      .setOnClickListener(onReread)
      .build(),
  )
  FixtureCatalog.restrictionRows(limits).forEach { list.addItem(row(it)) }
  return ListTemplate.Builder()
    .setHeader(header("Restrictions", back = true))
    .setSingleList(list.build())
    .build()
}
