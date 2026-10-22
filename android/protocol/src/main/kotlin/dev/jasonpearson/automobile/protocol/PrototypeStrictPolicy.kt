package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Additional unprivileged-import and negotiated-capability checks after full validation. */
internal object PrototypeStrictPolicy {
  fun error(
    spec: JsonObject,
    supported: Set<String>?,
    library: Boolean,
    actions: List<Located>,
  ): PrototypeSpecError? {
    if (supported != null && !supported.containsAll(required(spec))) {
      return PrototypeSpecError("$", "Unsupported capabilities")
    }
    val window = spec["window"] as? JsonObject
    if (library && window?.text("layer") == "system")
      return PrototypeSpecError("window.layer", "Privileged window")
    if (library && window?.text("persistence") == "device")
      return PrototypeSpecError("window.persistence", "Privileged window")
    if (library) {
      // Located actions exclude opaque data, request bodies and emit payloads.
      val host = actions.firstOrNull {
        it.value.text("type") == "request" && it.value.text("via") == "host"
      }
      if (host != null)
        return PrototypeSpecError("${host.path}.via", "Host requests are unavailable in a library")
    }
    return null
  }

  fun required(spec: JsonObject): Set<String> {
    val scanner = CapabilityScanner()
    scanner.envelope(spec)
    spec["root"]?.let { scanner.scan(it) }
    scanner.platform(spec)
    return scanner.result
  }

  private val typeFeatures =
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
      "request" to "network",
      "setData" to "data_actions",
      "appendData" to "data_actions",
      "removeData" to "data_actions",
      "platform" to "platform",
    )

  // Each feature applies when its node type has any of the listed fields.
  private val typeFieldFeatures =
    mapOf(
      "text" to mapOf("rich_text" to listOf("spans")),
      "textField" to
        mapOf(
          "text_field_options" to
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
            ),
          "text_field_actions" to listOf("trailingIcon", "imeAction", "onSubmit"),
          "text_field_leading_icon" to listOf("leadingIcon"),
        ),
      "pager" to
        mapOf(
          "pager_options" to listOf("axis", "pageSpacing", "peek", "pageSize"),
          "carousel" to listOf("indicator"),
        ),
      "scroll" to
        mapOf("chat_scroll" to listOf("reverse", "stickToEnd", "atEndKey", "onStartReached")),
      "emit" to mapOf("emit_context" to listOf("context")),
    )

  private val fieldFeatures =
    mapOf(
      "checks" to "checks",
      "validateOn" to "checks",
      "enabledWhen" to "checks",
      "valid" to "checks",
      "requireValid" to "checks",
      "onLongPress" to "gestures",
      "onDoubleTap" to "gestures",
      "swipeActions" to "swipe_actions",
      "refresh" to "refresh",
      "linkify" to "linkify",
      "empty" to "loading_states",
      "shimmer" to "loading_states",
    )

  private fun usesData(raw: JsonElement?, kind: PrototypeBindableKind): Boolean =
    when (kind) {
      PrototypeBindableKind.EMIT_BINDING -> (raw as? JsonObject)?.text("data") != null
      PrototypeBindableKind.TEXT,
      PrototypeBindableKind.REQUEST_TEXT -> {
        val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content
        text != null && PrototypeDataText.hasBinding(text)
      }
      else -> false
    }

  private class CapabilityScanner {
    val result = mutableSetOf<String>()

    private fun need(feature: String) {
      result.add("prototype_${feature}_v1")
    }

    fun envelope(spec: JsonObject) {
      if (spec["data"] != null) need("data_model")
      if (spec["storage"] != null) need("storage")
      val colors = (spec["theme"] as? JsonObject)?.get("colors") as? JsonObject
      if (colors?.get("light") != null || colors?.get("dark") != null) need("theme_modes")
    }

    fun platform(spec: JsonObject) {
      val scrim = ((spec["window"] as? JsonObject)?.get("placement") as? JsonObject)?.get("scrim")
      if (scrim is JsonObject) need("theme_modes")
      val modules = (spec["requires"] as? JsonObject)?.get("platform") as? JsonArray
      modules?.forEach {
        need("platform")
        need("platform_${it.jsonPrimitive.content}")
      }
      if (spec["platform"] != null) need("platform")
    }

    fun scan(value: JsonElement, field: String = "") {
      if (value is JsonArray) {
        value.forEach { scan(it) }
        return
      }
      val fields = value as? JsonObject ?: return
      if (fields.size == 1 && fields.containsKey("value")) return
      nodeFeatures(fields)
      scanFields(fields, field)
    }

    private fun scanFields(fields: JsonObject, field: String) {
      val type = fields.text("type") ?: ""
      for ((key, child) in fields) {
        if (key == "payload" || (key == "value" && type !in listOf("setData", "appendData")))
          continue
        if (key == "repeat") {
          repeatFeatures(child)
          continue
        }
        fieldFeatures(key, child, field)
        if (key != "linkify" && key != "series") scan(child, key)
      }
    }

    private fun nodeFeatures(fields: JsonObject) {
      val binding =
        PrototypeBindableFields.first<Boolean>(fields, "") { raw, _, kind ->
          if (usesData(raw, kind)) true else null
        }
      if (binding == true) need("data_model")
      val type = fields.text("type") ?: ""
      typeFeatures[type]?.let(::need)
      for ((feature, keys) in typeFieldFeatures[type].orEmpty()) {
        if (keys.any { fields[it] != null }) need(feature)
      }
      if (type == "request" && fields.text("via") == "device") need("network_device")
    }

    private fun repeatFeatures(child: JsonElement) {
      val repeatSpec = child as? JsonObject
      if (repeatSpec?.get("items") is JsonObject || repeatSpec?.get("key") != null)
        need("data_model")
    }

    private fun fieldFeatures(key: String, child: JsonElement, field: String) {
      fieldFeatures[key]?.let(::need)
      if (usesMotion(key, child)) result.add("prototype_motion_v2")
      if (key == "data" && child is JsonPrimitive && child.isString) need("data_model")
      if (key in listOf("light", "dark") && field.isNotEmpty()) need("theme_modes")
    }

    private fun usesMotion(key: String, child: JsonElement): Boolean =
      when (key) {
        "animate",
        "scale",
        "rotation",
        "zoomable" -> true
        "transition" ->
          (child as? JsonPrimitive)?.content in listOf("slideStart", "slideEnd", "scale")
        else -> false
      }
  }
}
