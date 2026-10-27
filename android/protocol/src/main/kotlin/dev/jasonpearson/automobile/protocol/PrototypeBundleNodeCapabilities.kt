package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.text
import kotlinx.serialization.json.*

internal object PrototypeBundleNodeCapabilities {
  fun collect(n: JsonObject): Set<String> {
    val caps = linkedSetOf<String>()
    if (PrototypeStylePolishV2Rules.required(n)) caps.add(PrototypeStylePolishV2Rules.CAPABILITY)
    val type = text(n["type"])
    val typed =
      mapOf(
        "carousel" to "carousel_v1",
        "searchBar" to "search_bar_v1",
        "chart" to "chart_v1",
        "list" to "lazy_list_v1",
        "stack" to "stack_v1",
        "menu" to "menus_v1",
        "tooltip" to "tooltip_v1",
        "drawer" to "drawer_v1",
        "select" to "menus_v1",
        "flow" to "flow_grid_v1",
        "grid" to "flow_grid_v1",
      )
    typed[type]?.let { caps.add("prototype_$it") }
    if ("ios" in n || "android" in n) caps.add("prototype_platform_namespace_v1")
    general(n, type, caps)
    controls(n, type, caps)
    appearance(n, type, caps)
    return caps
  }

  private fun general(n: JsonObject, type: String?, caps: MutableSet<String>) {
    fun mark(name: String, used: Boolean) {
      if (used) caps.add("prototype_$name")
    }
    mark("semantics_v1", "semantics" in n)
    mark("platform_namespace_v1", "ios" in n || "android" in n)
    mark("window_motion_v1", (n["repeat"] as? JsonObject)?.get("stagger") != null)
    mark("shared_element_v1", "sharedKey" in n)
    mark("shared_element_v2", "shared" in n)
    mark("flow_grid_v1", "span" in n)
    mark("gestures_v1", n.keys.any { it in setOf("onLongPress", "onDoubleTap") })
    mark("swipe_actions_v1", type in setOf("row", "listItem") && "swipeActions" in n)
    mark("rich_text_v1", type == "text" && "spans" in n)
    mark("linkify_v1", type == "text" && "linkify" in n)
    mark("stack_transitions_v1", type == "stack" && "transition" in n)
    motion(n, type, caps)
  }

  private fun motion(n: JsonObject, type: String?, caps: MutableSet<String>) {
    fun mark(name: String, used: Boolean) {
      if (used) caps.add("prototype_$name")
    }
    val transition = if (type == "stack") null else n["transition"]
    val transitionType = (transition as? JsonObject)?.let { text(it["type"]) } ?: text(transition)
    mark("motion_v2", "animate" in n || transitionType in setOf("slideStart", "slideEnd", "scale"))
    mark(
      "choreography_v1",
      "stagger" in n || transition is JsonObject || transitionType == "blurReplace",
    )
    mark("motion_v2", type == "image" && "zoomable" in n)
  }

  private fun controls(n: JsonObject, type: String?, caps: MutableSet<String>) {
    val fields =
      when (type) {
        "textField" ->
          mapOf(
            "text_field_options_v1" to
              setOf(
                "label",
                "variant",
                "supportingText",
                "keyboardType",
                "secure",
                "multiline",
                "minLines",
                "maxLines",
                "maxLength",
              ),
            "text_field_actions_v1" to setOf("trailingIcon", "imeAction", "onSubmit"),
            "text_field_leading_icon_v1" to setOf("leadingIcon"),
            "string_conditions_v1" to setOf("errorWhen", "errorText"),
          )
        "topAppBar",
        "bottomNav",
        "tabBar" -> mapOf("bar_scroll_v1" to setOf("onScroll", "scroll"))
        "pager" ->
          mapOf(
            "carousel_v1" to setOf("indicator"),
            "pager_options_v1" to setOf("axis", "pageSpacing", "peek", "pageSize"),
          )
        "list" -> mapOf("refresh_v1" to setOf("refresh"))
        "scroll" ->
          mapOf(
            "refresh_v1" to setOf("refresh"),
            "chat_scroll_v1" to setOf("reverse", "stickToEnd", "atEndKey", "onStartReached"),
          )
        else -> emptyMap()
      }
    for ((capability, keys) in fields) if (keys.any(n::containsKey))
      caps.add("prototype_$capability")
  }

  private fun appearance(n: JsonObject, type: String?, caps: MutableSet<String>) {
    if ((n["filter"] as? JsonObject)?.get("tint") is JsonObject)
      caps.add("prototype_theme_modes_v1")
    val pairedImage = type == "image" && n["asset"] is JsonObject
    val scrim = type in setOf("bottomSheet", "drawer") && themed(n["scrim"])
    val items =
      (n["items"] as? JsonArray).orEmpty().any { (it as? JsonObject)?.get("image") is JsonObject }
    if (pairedImage || scrim || items) caps.add("prototype_theme_modes_v1")
    val styles =
      listOfNotNull(n["style"] as? JsonObject) +
        (n["styleWhen"] as? JsonArray).orEmpty().mapNotNull {
          (it as? JsonObject)?.get("style") as? JsonObject
        }
    for (style in styles) {
      if ("shader" in style) caps.add("prototype_custom_shaders_v1")
      if ("runSpacing" in style) caps.add("prototype_flow_grid_v1")
      if ("scale" in style || "rotation" in style) caps.add("prototype_motion_v2")
      if ("effects" in style) caps.add("prototype_effects_v1")
      if (themedStyle(style)) caps.add("prototype_theme_modes_v1")
    }
  }

  private fun themedStyle(style: JsonObject): Boolean {
    val paired = listOf("background", "color", "shadowColor").any { style[it] is JsonObject }
    val border = (style["border"] as? JsonObject)?.get("color") is JsonObject
    val stops = ((style["gradient"] as? JsonObject)?.get("stops") as? JsonArray).orEmpty()
    val shadows =
      (style["shadows"] as? JsonArray).orEmpty().any {
        (it as? JsonObject)?.get("color") is JsonObject
      }
    val borderStops =
      (((style["border"] as? JsonObject)?.get("gradient") as? JsonObject)?.get("stops")
          as? JsonArray)
        .orEmpty()
    return shadows ||
      borderStops.any { themed((it as? JsonObject)?.get("color")) } ||
      paired ||
      border ||
      stops.any { themed((it as? JsonObject)?.get("color")) }
  }

  fun themed(value: JsonElement?) = value is JsonObject || (text(value)?.startsWith('#') == false)
}
