package dev.jasonpearson.automobile.sdk.carapp

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Read-only snapshot of the Car App Library screen stacks (#16751). It carries no Car App Library
 * types, so the debug provider can answer "disabled" in an app that never links the library.
 *
 * Every template is the last one the app returned from `Screen.onGetTemplate` and recorded through
 * [AutoMobileCarAppTemplates.record]; it is never a reading of what the host rendered.
 */
@Serializable
internal data class CarAppTemplateDocument(
  val schemaVersion: Int = SCHEMA_VERSION,
  val enabled: Boolean,
  val sessions: List<CarAppSessionSnapshot> = emptyList(),
  /** Why an enabled route could not walk the stacks, e.g. `main_thread_timeout`. */
  val error: String? = null,
) {
  companion object {
    const val SCHEMA_VERSION = 1

    fun disabled(): CarAppTemplateDocument = CarAppTemplateDocument(enabled = false)
  }
}

/** One `ScreenManager` stack, root screen first and the top screen last. */
@Serializable
internal data class CarAppSessionSnapshot(val id: String, val screens: List<CarAppScreenSnapshot>)

@Serializable
internal data class CarAppScreenSnapshot(
  val id: String,
  val screenClass: String,
  val top: Boolean,
  val marker: String? = null,
  /** Absent when the screen has not passed a template through `record` yet. */
  val template: CarAppTemplateNode? = null,
)

@Serializable
internal data class CarAppTemplateNode(
  val id: String,
  val type: String,
  val title: String? = null,
  val loading: Boolean? = null,
  val message: String? = null,
  val searchHint: String? = null,
  val initialSearchText: String? = null,
  val headerActions: List<CarAppActionNode> = emptyList(),
  val items: List<CarAppItemNode> = emptyList(),
  val actions: List<CarAppActionNode> = emptyList(),
  val actionStrips: List<CarAppActionStripNode> = emptyList(),
  val tabs: List<CarAppTabNode> = emptyList(),
  /** The template shown under the active tab of a `TabTemplate`. */
  val tabContent: CarAppTemplateNode? = null,
)

@Serializable
internal data class CarAppItemNode(
  val id: String,
  val kind: String,
  val title: String? = null,
  val section: String? = null,
  val texts: List<String> = emptyList(),
  val hasImage: Boolean = false,
  /** Checked state of the row's toggle; absent when the row has no toggle. */
  val toggle: Boolean? = null,
  val browsable: Boolean = false,
  val enabled: Boolean = true,
  val actions: List<CarAppActionNode> = emptyList(),
)

@Serializable
internal data class CarAppActionNode(
  val id: String,
  val type: String,
  val title: String? = null,
  val hasIcon: Boolean = false,
  val enabled: Boolean = true,
)

@Serializable
internal data class CarAppActionStripNode(
  val id: String,
  val role: String,
  val actions: List<CarAppActionNode>,
)

@Serializable
internal data class CarAppTabNode(
  val id: String,
  val contentId: String,
  val title: String? = null,
  val hasIcon: Boolean = false,
  val active: Boolean = false,
)

/** The same node with [prefix] put in front of every id in it. */
internal fun CarAppTemplateNode.withIdPrefix(prefix: String): CarAppTemplateNode =
  copy(
    id = prefix + id,
    headerActions = headerActions.map { it.copy(id = prefix + it.id) },
    items =
      items.map { item ->
        item.copy(
          id = prefix + item.id,
          actions = item.actions.map { it.copy(id = prefix + it.id) },
        )
      },
    actions = actions.map { it.copy(id = prefix + it.id) },
    actionStrips =
      actionStrips.map { strip ->
        strip.copy(
          id = prefix + strip.id,
          actions = strip.actions.map { it.copy(id = prefix + it.id) },
        )
      },
    tabs = tabs.map { it.copy(id = prefix + it.id) },
    tabContent = tabContent?.withIdPrefix(prefix),
  )

private val documentJson = Json {
  encodeDefaults = true
  explicitNulls = false
}

internal fun CarAppTemplateDocument.toJson(): String =
  documentJson.encodeToString(CarAppTemplateDocument.serializer(), this)

internal fun decodeCarAppTemplateDocument(json: String): CarAppTemplateDocument =
  documentJson.decodeFromString(CarAppTemplateDocument.serializer(), json)

/**
 * The car-free handle the debug provider reads. [AutoMobileCarAppTemplates.enable] installs the
 * source; until then the route answers `enabled: false` and nothing walks a screen stack.
 */
internal object CarAppTemplateRoute {
  @Volatile internal var source: (() -> CarAppTemplateDocument)? = null

  fun snapshotJson(): String = (source?.invoke() ?: CarAppTemplateDocument.disabled()).toJson()
}
