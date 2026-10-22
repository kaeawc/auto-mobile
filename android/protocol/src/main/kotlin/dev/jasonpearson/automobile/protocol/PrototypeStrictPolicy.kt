package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Additional unprivileged-import and negotiated-capability checks after full validation. */
internal object PrototypeStrictPolicy {
  fun error(spec: JsonObject, supported: Set<String>?, library: Boolean): PrototypeSpecError? {
    if (supported != null && !supported.containsAll(required(spec))) {
      return PrototypeSpecError("$", "Unsupported capabilities")
    }
    val window = spec["window"] as? JsonObject
    if (library && window?.text("layer") == "system")
      return PrototypeSpecError("window.layer", "Privileged window")
    if (library && window?.text("persistence") == "device")
      return PrototypeSpecError("window.persistence", "Privileged window")
    return null
  }

  fun required(spec: JsonObject): Set<String> {
    val result = mutableSetOf<String>()
    fun need(feature: String) {
      result.add("prototype_${feature}_v1")
    }
    if (spec["data"] != null) need("data_model")
    if (spec["storage"] != null) need("storage")
    val colors = (spec["theme"] as? JsonObject)?.get("colors") as? JsonObject
    if (colors?.get("light") != null || colors?.get("dark") != null) need("theme_modes")
    fun scan(value: JsonElement, field: String = "") {
      if (value is JsonArray) {
        value.forEach { scan(it) }
        return
      }
      val fields = value as? JsonObject ?: return
      if (fields.size == 1 && fields.containsKey("value")) return
      val usesData =
        PrototypeBindableFields.first<Boolean>(fields, "") { raw, _, kind ->
          val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content
          val textual =
            kind in listOf(PrototypeBindableKind.TEXT, PrototypeBindableKind.REQUEST_TEXT)
          val binding =
            kind == PrototypeBindableKind.EMIT_BINDING && (raw as? JsonObject)?.text("data") != null
          if (binding || (textual && text != null && PrototypeDataText.hasBinding(text))) true
          else null
        }
      if (usesData == true) need("data_model")
      val type = fields.text("type") ?: ""
      val types =
        mapOf(
          "stack" to "stack",
          "flow" to "flow_grid",
          "grid" to "flow_grid",
          "carousel" to "carousel",
          "searchBar" to "search_bar",
          "chart" to "chart",
          "menu" to "menus",
          "select" to "menus",
          "scrollTo" to "chat_scroll",
        )
      types[type]?.let(::need)
      if (type == "text" && fields["spans"] != null) need("rich_text")
      if (type == "textField") {
        if (
          listOf(
              "label",
              "variant",
              "supportingText",
              "keyboardType",
              "secure",
              "multiline",
              "minLines",
              "maxLines",
              "maxLength",
            )
            .any { fields[it] != null }
        )
          need("text_field_options")
        if (listOf("trailingIcon", "imeAction", "onSubmit").any { fields[it] != null })
          need("text_field_actions")
        if (fields["leadingIcon"] != null) need("text_field_leading_icon")
      }
      if (type == "pager") {
        if (listOf("axis", "pageSpacing", "peek", "pageSize").any { fields[it] != null })
          need("pager_options")
        if (fields["indicator"] != null) need("carousel")
      }
      if (
        type == "scroll" &&
          listOf("reverse", "stickToEnd", "atEndKey", "onStartReached").any { fields[it] != null }
      )
        need("chat_scroll")
      if (type == "request") {
        need("network")
        if (fields.text("via") == "device") need("network_device")
      }
      if (type in listOf("setData", "appendData", "removeData")) need("data_actions")
      if (type == "emit" && fields["context"] != null) need("emit_context")
      if (type == "platform") need("platform")
      for ((key, child) in fields) {
        if (key == "payload" || (key == "value" && type !in listOf("setData", "appendData")))
          continue
        if (key == "repeat") {
          val repeatSpec = child as? JsonObject
          if (repeatSpec?.get("items") is JsonObject || repeatSpec?.get("key") != null)
            need("data_model")
          continue
        }
        if (key in listOf("checks", "validateOn", "enabledWhen", "valid", "requireValid"))
          need("checks")
        if (key in listOf("onLongPress", "onDoubleTap")) need("gestures")
        if (key == "swipeActions") need("swipe_actions")
        if (key == "refresh") need("refresh")
        if (key == "linkify") need("linkify")
        if (key in listOf("empty", "shimmer")) need("loading_states")
        if (
          key in listOf("animate", "scale", "rotation", "zoomable") ||
            (key == "transition" &&
              (child as? JsonPrimitive)?.content in listOf("slideStart", "slideEnd", "scale"))
        )
          result.add("prototype_motion_v2")
        if (key == "data" && child is JsonPrimitive && child.isString) need("data_model")
        if (key in listOf("light", "dark") && field.isNotEmpty()) need("theme_modes")
        if (key != "linkify" && key != "series") scan(child, key)
      }
    }
    spec["root"]?.let { scan(it) }
    val scrim = ((spec["window"] as? JsonObject)?.get("placement") as? JsonObject)?.get("scrim")
    if (scrim is JsonObject) need("theme_modes")
    val modules = (spec["requires"] as? JsonObject)?.get("platform") as? JsonArray
    modules?.forEach {
      need("platform")
      need("platform_${it.jsonPrimitive.content}")
    }
    if (spec["platform"] != null) need("platform")
    return result
  }
}
