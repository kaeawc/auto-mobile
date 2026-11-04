package dev.jasonpearson.automobile.sdk.carapp

import androidx.annotation.OptIn
import androidx.car.app.annotations.ExperimentalCarApi
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarText
import androidx.car.app.model.GridItem
import androidx.car.app.model.Header
import androidx.car.app.model.Item
import androidx.car.app.model.ItemList
import androidx.car.app.model.Row

/**
 * Maps the parts templates share (items, actions, action strips, header and text) to snapshot nodes
 * (#16751). Pure, like [CarAppTemplateMapper], which builds each template from these.
 */
internal object CarAppElementMapper {
  fun mapItems(list: ItemList?, base: String, section: String? = null) =
    list?.items.orEmpty().mapIndexed { index, item -> mapItem(item, "$base/$index", section) }

  fun mapItem(item: Item, id: String, section: String?): CarAppItemNode =
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

  fun headerTitle(header: Header?, legacyTitle: CarText?): String? =
    text(header?.title) ?: text(legacyTitle)

  fun headerActions(header: Header?, legacy: Action?, id: String): List<CarAppActionNode> {
    val actions =
      if (header != null) {
        listOfNotNull(header.startHeaderAction) + header.endHeaderActions
      } else {
        listOfNotNull(legacy)
      }
    return mapActions(actions, "$id/header/actions")
  }

  fun mapStrip(strip: ActionStrip?, role: String, id: String): CarAppActionStripNode? = strip?.let {
    CarAppActionStripNode(
      id = "$id/$role",
      role = role,
      actions = mapActions(it.actions, "$id/$role/actions"),
    )
  }

  fun mapActions(actions: List<Action>, base: String): List<CarAppActionNode> =
    actions.mapIndexed { index, action ->
      CarAppActionNode(
        id = "$base/$index",
        type = actionType(action.type),
        title = text(action.title),
        hasIcon = action.icon != null,
        enabled = action.isEnabled,
      )
    }

  @OptIn(markerClass = [ExperimentalCarApi::class]) // TYPE_COMPOSE_MESSAGE is experimental.
  private fun actionType(type: Int): String =
    when (type) {
      Action.TYPE_CUSTOM -> "custom"
      Action.TYPE_APP_ICON -> "appIcon"
      Action.TYPE_BACK -> "back"
      Action.TYPE_PAN -> "pan"
      Action.TYPE_COMPOSE_MESSAGE -> "composeMessage"
      else -> "other"
    }

  fun text(value: CarText?): String? =
    value?.takeUnless { it.isEmpty }?.toCharSequence()?.toString()
}
