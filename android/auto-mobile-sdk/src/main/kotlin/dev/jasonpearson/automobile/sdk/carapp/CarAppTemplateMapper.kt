package dev.jasonpearson.automobile.sdk.carapp

import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarText
import androidx.car.app.model.GridItem
import androidx.car.app.model.GridTemplate
import androidx.car.app.model.Header
import androidx.car.app.model.Item
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.LongMessageTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.TabTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.NavigationTemplate

/**
 * Maps a Car App Library [Template] to its snapshot node (#16751). Pure: it reads only the
 * immutable template model, never a screen or the host, so it runs off the main thread.
 *
 * Ids are slash-separated paths below [id], e.g. `session0/screen1/template/items/2/actions/0`.
 */
internal object CarAppTemplateMapper {

  fun map(template: Template, id: String): CarAppTemplateNode =
    when (template) {
      is ListTemplate -> mapList(template, id)
      is GridTemplate -> mapGrid(template, id)
      is PaneTemplate -> mapPane(template, id)
      is MessageTemplate -> mapMessage(template, id)
      is LongMessageTemplate -> mapLongMessage(template, id)
      is SearchTemplate -> mapSearch(template, id)
      is TabTemplate -> mapTabs(template, id)
      is NavigationTemplate -> mapNavigation(template, id)
      else -> CarAppTemplateNode(id = id, type = template.javaClass.simpleName)
    }

  @Suppress("DEPRECATION") // Pre-Header templates still set title and header action directly.
  private fun mapList(template: ListTemplate, id: String): CarAppTemplateNode {
    val sections = template.sectionedLists
    val items =
      if (sections.isEmpty()) {
        mapItems(template.singleList, "$id/items")
      } else {
        sections.flatMapIndexed { index, section ->
          mapItems(section.itemList, "$id/sections/$index/items", text(section.header))
        }
      }
    return CarAppTemplateNode(
      id = id,
      type = "ListTemplate",
      title = headerTitle(template.header, template.title),
      loading = template.isLoading.takeIf { it },
      headerActions = headerActions(template.header, template.headerAction, id),
      items = items,
      actions = mapActions(template.actions, "$id/actions"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )
  }

  @Suppress("DEPRECATION")
  private fun mapGrid(template: GridTemplate, id: String): CarAppTemplateNode =
    CarAppTemplateNode(
      id = id,
      type = "GridTemplate",
      title = headerTitle(template.header, template.title),
      loading = template.isLoading.takeIf { it },
      headerActions = headerActions(template.header, template.headerAction, id),
      items = mapItems(template.singleList, "$id/items"),
      actions = mapActions(template.actions, "$id/actions"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )

  @Suppress("DEPRECATION")
  private fun mapPane(template: PaneTemplate, id: String): CarAppTemplateNode {
    val pane = template.pane
    return CarAppTemplateNode(
      id = id,
      type = "PaneTemplate",
      title = headerTitle(template.header, template.title),
      loading = pane.isLoading.takeIf { it },
      headerActions = headerActions(template.header, template.headerAction, id),
      items = pane.rows.mapIndexed { index, row -> mapItem(row, "$id/items/$index", null) },
      actions = mapActions(pane.actions, "$id/actions"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )
  }

  @Suppress("DEPRECATION")
  private fun mapMessage(template: MessageTemplate, id: String): CarAppTemplateNode =
    CarAppTemplateNode(
      id = id,
      type = "MessageTemplate",
      title = headerTitle(template.header, template.title),
      loading = template.isLoading.takeIf { it },
      message = text(template.message),
      headerActions = headerActions(template.header, template.headerAction, id),
      actions = mapActions(template.actions, "$id/actions"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )

  private fun mapLongMessage(template: LongMessageTemplate, id: String): CarAppTemplateNode =
    CarAppTemplateNode(
      id = id,
      type = "LongMessageTemplate",
      title = text(template.title),
      message = text(template.message),
      headerActions = headerActions(null, template.headerAction, id),
      actions = mapActions(template.actions, "$id/actions"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )

  private fun mapSearch(template: SearchTemplate, id: String): CarAppTemplateNode =
    CarAppTemplateNode(
      id = id,
      type = "SearchTemplate",
      loading = template.isLoading.takeIf { it },
      searchHint = template.searchHint,
      initialSearchText = template.initialSearchText,
      headerActions = headerActions(null, template.headerAction, id),
      items = mapItems(template.itemList, "$id/items"),
      actionStrips = listOfNotNull(mapStrip(template.actionStrip, "actionStrip", id)),
    )

  private fun mapTabs(template: TabTemplate, id: String): CarAppTemplateNode {
    val activeId = runCatching { template.activeTabContentId }.getOrNull()
    val content = if (template.isLoading) null else template.tabContents
    return CarAppTemplateNode(
      id = id,
      type = "TabTemplate",
      loading = template.isLoading.takeIf { it },
      headerActions = headerActions(null, template.headerAction, id),
      tabs =
        template.tabs.mapIndexed { index, tab ->
          CarAppTabNode(
            id = "$id/tabs/$index",
            contentId = tab.contentId,
            title = text(tab.title),
            hasIcon = tab.icon != null,
            active = tab.contentId == activeId,
          )
        },
      tabContent = content?.let { map(it.template, "$id/tabContent") },
    )
  }

  private fun mapNavigation(template: NavigationTemplate, id: String): CarAppTemplateNode =
    CarAppTemplateNode(
      id = id,
      type = "NavigationTemplate",
      actionStrips =
        listOfNotNull(
          mapStrip(template.actionStrip, "actionStrip", id),
          mapStrip(template.mapActionStrip, "mapActionStrip", id),
        ),
    )

  private fun mapItems(list: ItemList?, base: String, section: String? = null) =
    list?.items.orEmpty().mapIndexed { index, item -> mapItem(item, "$base/$index", section) }

  private fun mapItem(item: Item, id: String, section: String?): CarAppItemNode =
    when (item) {
      is Row ->
        CarAppItemNode(
          id = id,
          kind = "row",
          title = text(item.title),
          section = section,
          texts = item.texts.mapNotNull { text(it) },
          hasImage = item.image != null,
          toggle = item.toggle?.isChecked,
          browsable = item.isBrowsable,
          enabled = item.isEnabled,
          actions = mapActions(item.actions, "$id/actions"),
        )
      is GridItem ->
        CarAppItemNode(
          id = id,
          kind = "gridItem",
          title = text(item.title),
          section = section,
          texts = listOfNotNull(text(item.text)),
          hasImage = item.image != null,
        )
      else -> CarAppItemNode(id = id, kind = item.javaClass.simpleName, section = section)
    }

  private fun headerTitle(header: Header?, legacyTitle: CarText?): String? =
    text(header?.title) ?: text(legacyTitle)

  private fun headerActions(header: Header?, legacy: Action?, id: String): List<CarAppActionNode> {
    val actions =
      if (header != null) {
        listOfNotNull(header.startHeaderAction) + header.endHeaderActions
      } else {
        listOfNotNull(legacy)
      }
    return mapActions(actions, "$id/header/actions")
  }

  private fun mapStrip(strip: ActionStrip?, role: String, id: String): CarAppActionStripNode? =
    strip?.let {
      CarAppActionStripNode(
        id = "$id/$role",
        role = role,
        actions = mapActions(it.actions, "$id/$role/actions"),
      )
    }

  private fun mapActions(actions: List<Action>, base: String): List<CarAppActionNode> =
    actions.mapIndexed { index, action ->
      CarAppActionNode(
        id = "$base/$index",
        type = actionType(action.type),
        title = text(action.title),
        hasIcon = action.icon != null,
        enabled = action.isEnabled,
      )
    }

  private fun actionType(type: Int): String =
    when (type) {
      Action.TYPE_CUSTOM -> "custom"
      Action.TYPE_APP_ICON -> "appIcon"
      Action.TYPE_BACK -> "back"
      Action.TYPE_PAN -> "pan"
      Action.TYPE_COMPOSE_MESSAGE -> "composeMessage"
      else -> "other"
    }

  private fun text(value: CarText?): String? =
    value?.takeUnless { it.isEmpty }?.toCharSequence()?.toString()
}
