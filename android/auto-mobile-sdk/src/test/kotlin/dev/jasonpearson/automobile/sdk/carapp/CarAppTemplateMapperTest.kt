package dev.jasonpearson.automobile.sdk.carapp

import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.GridItem
import androidx.car.app.model.GridTemplate
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Toggle
import androidx.car.app.navigation.model.NavigationTemplate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CarAppTemplateMapperTest {

  @Test
  fun `list rows carry title, texts, image presence, toggle state and browsable`() {
    val toggled =
      Row.Builder()
        .setTitle("Wi-Fi")
        .addText("Connected")
        .setToggle(Toggle.Builder {}.setChecked(true).build())
        .build()
    val browsable =
      Row.Builder()
        .setTitle("Albums")
        .setImage(CarIcon.APP_ICON)
        .setBrowsable(true)
        .setOnClickListener {}
        .build()
    val template =
      ListTemplate.Builder()
        .setHeader(
          Header.Builder()
            .setTitle("Settings")
            .setStartHeaderAction(Action.BACK)
            .addEndHeaderAction(Action.Builder().setTitle("Edit").setOnClickListener {}.build())
            .build(),
        )
        .setSingleList(ItemList.Builder().addItem(toggled).addItem(browsable).build())
        .setActionStrip(
          ActionStrip.Builder()
            .addAction(Action.Builder().setTitle("Help").setOnClickListener {}.build())
            .build(),
        )
        .build()

    val node = CarAppTemplateMapper.map(template, "t")

    assertEquals("ListTemplate", node.type)
    assertEquals("Settings", node.title)
    assertEquals(listOf("back", "custom"), node.headerActions.map { it.type })
    assertEquals(
      listOf("t/header/actions/0", "t/header/actions/1"),
      node.headerActions.map { it.id },
    )
    assertEquals("Edit", node.headerActions[1].title)

    val (wifi, albums) = node.items
    assertEquals("t/items/0", wifi.id)
    assertEquals("row", wifi.kind)
    assertEquals("Wi-Fi", wifi.title)
    assertEquals(listOf("Connected"), wifi.texts)
    assertEquals(true, wifi.toggle)
    assertFalse(wifi.hasImage)
    assertFalse(wifi.browsable)
    assertNull(albums.toggle)
    assertTrue(albums.hasImage)
    assertTrue(albums.browsable)

    val strip = node.actionStrips.single()
    assertEquals("t/actionStrip", strip.id)
    assertEquals("Help", strip.actions.single().title)
    assertEquals("t/actionStrip/actions/0", strip.actions.single().id)
  }

  @Test
  fun `sectioned lists keep the section header on each item and a section path id`() {
    val template =
      ListTemplate.Builder()
        .setTitle("Library")
        .addSectionedList(
          SectionedItemList.create(
            ItemList.Builder().addItem(Row.Builder().setTitle("One").build()).build(),
            "Recent",
          ),
        )
        .addSectionedList(
          SectionedItemList.create(
            ItemList.Builder().addItem(Row.Builder().setTitle("Two").build()).build(),
            "All",
          ),
        )
        .build()

    val items = CarAppTemplateMapper.map(template, "t").items

    assertEquals(listOf("t/sections/0/items/0", "t/sections/1/items/0"), items.map { it.id })
    assertEquals(listOf("Recent", "All"), items.map { it.section })
  }

  @Test
  fun `grid items report title, text and image presence`() {
    val template =
      GridTemplate.Builder()
        .setTitle("Apps")
        .setSingleList(
          ItemList.Builder()
            .addItem(
              GridItem.Builder().setTitle("Maps").setText("Nav").setImage(CarIcon.APP_ICON).build(),
            )
            .build(),
        )
        .build()

    val item = CarAppTemplateMapper.map(template, "t").items.single()

    assertEquals("gridItem", item.kind)
    assertEquals("Maps", item.title)
    assertEquals(listOf("Nav"), item.texts)
    assertTrue(item.hasImage)
  }

  @Test
  fun `pane rows and actions map, and a loading pane says so`() {
    val pane =
      Pane.Builder()
        .addRow(Row.Builder().setTitle("Address").build())
        .addAction(Action.Builder().setTitle("Go").setOnClickListener {}.build())
        .build()
    val node = CarAppTemplateMapper.map(PaneTemplate.Builder(pane).setTitle("Place").build(), "t")

    assertEquals("PaneTemplate", node.type)
    assertEquals("Place", node.title)
    assertEquals("Address", node.items.single().title)
    assertEquals("t/actions/0", node.actions.single().id)
    assertNull(node.loading)

    val loading = Pane.Builder().setLoading(true).build()
    assertEquals(
      true,
      CarAppTemplateMapper.map(PaneTemplate.Builder(loading).setTitle("Place").build(), "t")
        .loading,
    )
  }

  @Test
  fun `search reports hint, initial text and results`() {
    val template =
      SearchTemplate.Builder(
          object : SearchTemplate.SearchCallback {
            override fun onSearchTextChanged(searchText: String) = Unit

            override fun onSearchSubmitted(searchText: String) = Unit
          },
        )
        .setSearchHint("Search music")
        .setInitialSearchText("jazz")
        .setItemList(ItemList.Builder().addItem(Row.Builder().setTitle("Jazz FM").build()).build())
        .build()

    val node = CarAppTemplateMapper.map(template, "t")

    assertEquals("SearchTemplate", node.type)
    assertEquals("Search music", node.searchHint)
    assertEquals("jazz", node.initialSearchText)
    assertEquals("Jazz FM", node.items.single().title)
  }

  @Test
  fun `navigation reports both action strips by role`() {
    val strip = { title: String ->
      ActionStrip.Builder()
        .addAction(Action.Builder().setTitle(title).setOnClickListener {}.build())
        .build()
    }
    val template =
      NavigationTemplate.Builder()
        .setActionStrip(strip("Stop"))
        .setMapActionStrip(ActionStrip.Builder().addAction(Action.PAN).build())
        .build()

    val node = CarAppTemplateMapper.map(template, "t")

    assertEquals("NavigationTemplate", node.type)
    assertEquals(listOf("actionStrip", "mapActionStrip"), node.actionStrips.map { it.role })
    assertEquals("t/mapActionStrip/actions/0", node.actionStrips[1].actions.single().id)
    assertEquals("pan", node.actionStrips[1].actions.single().type)
  }

  @Test
  fun `the encoded document omits absent fields`() {
    val json =
      CarAppTemplateDocument(
          enabled = true,
          sessions =
            listOf(
              CarAppSessionSnapshot(
                "session0",
                listOf(CarAppScreenSnapshot("session0/screen0", "a.B", top = true)),
              ),
            ),
        )
        .toJson()

    assertEquals(
      """{"schemaVersion":1,"enabled":true,"sessions":[{"id":"session0","screens":[{"id":"session0/screen0","screenClass":"a.B","top":true}]}]}""",
      json,
    )
  }
}
