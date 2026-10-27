package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Additional unprivileged-import and negotiated-capability checks after full validation. */
internal object PrototypeStrictPolicy {
  fun error(
    spec: JsonObject,
    supported: Set<String>?,
    library: Boolean,
    context: PrototypeStateChecks.Context,
  ): PrototypeSpecError? {
    if (supported != null && !supported.containsAll(required(spec))) {
      return PrototypeSpecError(
        "$",
        "Unsupported capabilities: " + (required(spec) - supported).sorted().joinToString(", "),
      )
    }
    if (library && "prototype_custom_shaders_v1" in required(spec))
      return PrototypeSpecError(
        "$",
        "ProtoViewer bundles refuse custom AGSL shaders",
      )
    val window = spec["window"] as? JsonObject
    if (library && window?.text("layer") == "system")
      return PrototypeSpecError("window.layer", "Privileged window")
    if (library && window?.text("persistence") == "device")
      return PrototypeSpecError("window.persistence", "Privileged window")
    if (library) {
      // Located actions exclude opaque data, request bodies and emit payloads.
      val host =
        context.actions.firstOrNull {
          it.value.text("type") == "request" && it.value.text("via") == "host"
        }
      if (host != null)
        return PrototypeSpecError("${host.path}.via", "Host requests are unavailable in a library")
    }
    return if (library) secureLibraryError(spec, context) else null
  }

  private data class Field(val text: String, val path: String, val key: Boolean)

  private fun secureLibraryError(
    spec: JsonObject,
    context: PrototypeStateChecks.Context,
  ): PrototypeSpecError? {
    val scopes = PrototypeRepeatValidator.scopes(spec)
    val secure = secureStateKeys(scopes, context)
    if (secure.isEmpty()) return null
    val requests = context.actions.filter { it.value.text("type") == "request" }.map { it.path }
    val leaked =
      requestFields(context)
        .sortedBy { it.path }
        .firstOrNull { field ->
          isSinkBinding(field, requests) && bindsSecure(field, scopes, secure)
        }
    if (leaked != null)
      return PrototypeSpecError(
        leaked.path,
        if (inRequest(leaked.path, requests)) "Secure value cannot be bound into a request"
        else "Secure value cannot be bound into an action payload",
      )
    return persistedSecureError(spec, secure)
  }

  private fun secureStateKeys(
    scopes: List<PrototypeRepeatValidator.Scope>,
    context: PrototypeStateChecks.Context,
  ): Set<String> =
    context.nodes
      .filter {
        it.value.text("type") == "textField" &&
          (it.value["secure"] == JsonPrimitive(true) || it.value.text("keyboardType") == "password")
      }
      .flatMap { node ->
        PrototypeRepeatValidator.keyInstances(
            scopes,
            JsonObject(mapOf("stateKey" to node.value.getValue("stateKey"))),
            node.path,
          )
          .mapNotNull { (value, _) -> value.text("stateKey") }
      }
      .toSet()

  private fun requestFields(context: PrototypeStateChecks.Context): List<Field> {
    val fields = mutableListOf<Field>()
    for (node in context.nodes) {
      PrototypeBindableFields.first<Boolean>(node.value, node.path) { raw, at, kind ->
        val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (
          text != null &&
            kind in listOf(PrototypeBindableKind.REQUEST_TEXT, PrototypeBindableKind.KEY)
        )
          fields.add(Field(text, at, kind == PrototypeBindableKind.KEY))
        null
      }
    }
    return fields
  }

  private fun isSinkBinding(field: Field, requests: List<String>): Boolean =
    // The binding visitor exposes request/data/emit/platform state bindings as KEY fields.
    (field.key && field.path.endsWith(".state")) || inRequest(field.path, requests)

  private fun inRequest(path: String, requests: List<String>): Boolean = requests.any { at ->
    path == "$at.url" ||
      path == "$at.body.state" ||
      listOf("headers", "query").any { path.startsWith("$at.$it.") || path.startsWith("$at.$it[") }
  }

  private fun bindsSecure(
    field: Field,
    scopes: List<PrototypeRepeatValidator.Scope>,
    secure: Set<String>,
  ): Boolean {
    val scope = scopes.firstOrNull { field.path.startsWith("${it.path}.children[") }
    val texts =
      if (scope == null || !PrototypeRepeatFields.hasPlaceholder(field.text, scope.alias))
        listOf(field.text)
      else
        scope.items.mapIndexed { index, item ->
          PrototypeRepeatTemplate.bind(field.text, scope.alias, item, index)
        }
    return texts.any { text ->
      if (field.key) text in secure else secure.any { text.contains("{$it}") }
    }
  }

  private fun persistedSecureError(spec: JsonObject, secure: Set<String>): PrototypeSpecError? {
    val keys = (spec["storage"] as? JsonObject)?.get("keys") as? JsonArray
    val index =
      keys?.indexOfFirst {
        (it as? JsonPrimitive)?.content?.let { key ->
          key.startsWith("state:") && key.removePrefix("state:") in secure
        } == true
      } ?: -1
    return if (index >= 0)
      PrototypeSpecError("storage.keys[$index]", "Secure value cannot be persisted")
    else null
  }

  fun required(spec: JsonObject): Set<String> {
    val scanner = CapabilityScanner()
    scanner.envelope(spec)
    spec["root"]?.let { scanner.scan(it) }
    scanner.platform(spec)
    (spec["platform"] as? JsonObject)?.get("on")?.let { scanner.scan(it) }
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
      "list" to "lazy_list",
      "menu" to "menus",
      "tooltip" to "tooltip",
      "drawer" to "drawer",
      "select" to "menus",
      "scrollTo" to "chat_scroll",
      "request" to "network",
      "startTimer" to "timers",
      "cancelTimer" to "timers",
      "setData" to "data_actions",
      "appendData" to "data_actions",
      "prependData" to "data_actions",
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
          "string_conditions" to listOf("errorWhen", "errorText"),
        ),
      "topAppBar" to mapOf("bar_scroll" to listOf("onScroll", "scroll")),
      "bottomNav" to mapOf("bar_scroll" to listOf("onScroll", "scroll")),
      "tabBar" to mapOf("bar_scroll" to listOf("onScroll", "scroll")),
      "pager" to
        mapOf(
          "pager_options" to listOf("axis", "pageSpacing", "peek", "pageSize"),
          "pager_state_key" to listOf("stateKey"),
          "carousel" to listOf("indicator"),
        ),
      "scroll" to
        mapOf("chat_scroll" to listOf("reverse", "stickToEnd", "atEndKey", "onStartReached")),
      "emit" to mapOf("emit_context" to listOf("context")),
    )

  private val fieldFeatures =
    mapOf(
      "semantics" to "semantics",
      "checks" to "checks",
      "validateOn" to "checks",
      "enabledWhen" to "checks",
      "valid" to "checks",
      "requireValid" to "checks",
      "onAppear" to "timers",
      "onLongPress" to "gestures",
      "onDoubleTap" to "gestures",
      "swipeActions" to "swipe_actions",
      "refresh" to "refresh",
      "linkify" to "linkify",
      "empty" to "loading_states",
      "shimmer" to "loading_states",
      "effects" to "effects",
      "sharedKey" to "shared_element",
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
      PrototypeEnvelopeFeatures.collect(spec).forEach(::need)
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
      if (PrototypeStringConditions.uses(fields)) need("string_conditions")
      nodeFeatures(fields)
      scanFields(fields, field)
    }

    private fun scanFields(fields: JsonObject, field: String) {
      val type = fields.text("type") ?: ""
      for ((key, child) in fields) {
        if (skipsScan(key, type)) continue
        if (key == "repeat") {
          repeatFeatures(child)
          continue
        }
        if (key == "transition" && type in setOf("stack", "push", "replace")) {
          need("stack_transitions")
        } else {
          fieldFeatures(key, child, field)
        }
        descend(key, child)
      }
    }

    private fun skipsScan(key: String, type: String): Boolean =
      key == "payload" ||
        (key == "value" && type !in listOf("setData", "appendData", "prependData"))

    // An effect's own `animate`, colours and params are not spec features of their own.
    private fun descend(key: String, child: JsonElement) {
      when {
        key == "linkify" -> (child as? JsonObject)?.get("onTap")?.let { scan(it, "onTap") }
        key !in listOf("series", "effects", "scrollLinked", "scrollTransition") -> scan(child, key)
      }
    }

    private fun nodeFeatures(fields: JsonObject) {
      if ("shared" in fields) result.add("prototype_shared_element_v2")
      val binding =
        PrototypeBindableFields.first<Boolean>(fields, "") { raw, _, kind ->
          if (usesData(raw, kind)) true else null
        }
      if (binding == true) need("data_model")
      if (PrototypeStylePolishV2Rules.themedBorder(fields)) need("theme_modes")
      if (PrototypeStylePolishV2Rules.required(fields))
        result.add(PrototypeStylePolishV2Rules.CAPABILITY)
      val type = fields.text("type") ?: ""
      val nodeTypes =
        PrototypeSpecContract.definitions
          .getValue("node")
          .jsonObject
          .getValue("variants")
          .jsonObject
      if (type in nodeTypes && ("ios" in fields || "android" in fields)) need("platform_namespace")
      typeFeatures[type]?.let(::need)
      for ((feature, keys) in typeFieldFeatures[type].orEmpty()) {
        if (keys.any { fields[it] != null }) need(feature)
      }
      listAndRequestFeatures(type, fields)
    }

    private fun listAndRequestFeatures(type: String, fields: JsonObject) {
      if (type == "prependData") need("lazy_list")
      if (type == "list" || (type == "request" && fields.containsKey("append"))) {
        need("lazy_list")
        need("data_model")
      }
      if (type == "request" && fields.text("via") == "device") need("network_device")
    }

    private fun repeatFeatures(child: JsonElement) {
      val repeatSpec = child as? JsonObject
      if (repeatSpec?.containsKey("derive") == true) need("format")
      if (repeatSpec?.get("stagger") != null) need("window_motion")
      if (repeatSpec?.get("items") is JsonObject || repeatSpec?.get("key") != null)
        need("data_model")
    }

    private fun fieldFeatures(key: String, child: JsonElement, field: String) {
      fieldFeatures[key]?.let(::need)
      if (key == "style" && (child as? JsonObject)?.containsKey("shader") == true)
        need("custom_shaders")
      if (PrototypeMotionFeatures.usesMotion(key, child)) result.add("prototype_motion_v2")
      if (key == "scrollLinked" || key == "scrollTransition") need("scroll_motion")
      if (PrototypeMotionFeatures.usesChoreography(key, child)) need("choreography")
      if (key == "data" && child is JsonPrimitive && child.isString) need("data_model")
      if (key in listOf("light", "dark") && field.isNotEmpty()) need("theme_modes")
    }
  }
}

/** Which per-field motion and choreography features a field uses (#15247). */
private object PrototypeMotionFeatures {
  fun usesMotion(key: String, child: JsonElement): Boolean =
    when (key) {
      "animate",
      "scale",
      "rotation",
      "zoomable" -> true
      "transition" -> transitionType(child) in listOf("slideStart", "slideEnd", "scale")
      else -> false
    }

  /** Transition delays, `blurReplace` and container `stagger` (#15247). */
  fun usesChoreography(key: String, child: JsonElement): Boolean =
    key == "stagger" ||
      (key == "transition" && (child is JsonObject || transitionType(child) == "blurReplace"))

  fun transitionType(child: JsonElement): String? =
    ((child as? JsonObject)?.get("type") ?: child).let { (it as? JsonPrimitive)?.content }
}

/**
 * The feature names a spec envelope (not its nodes) asks for, in the strict policy's vocabulary.
 */
internal object PrototypeEnvelopeFeatures {
  fun collect(spec: JsonObject): List<String> = buildList {
    content(spec)
    presentation(spec)
  }

  private fun MutableList<String>.content(spec: JsonObject) {
    if ("strings" in spec || PrototypeStrings.fields(spec).any { "{t:" in it.text }) add("strings")
    if (spec["data"] != null) add("data_model")
    if (spec["storage"] != null) add("storage")
    if ("derive" in spec) add("format")
  }

  private fun MutableList<String>.presentation(spec: JsonObject) {
    for (key in listOf("window", "theme")) {
      val block = spec[key] as? JsonObject ?: continue
      if ("ios" in block || "android" in block) add("platform_namespace")
    }
    if (spec.text("motion") == "reduced") add("reduced_motion")
    if ((spec["window"] as? JsonObject)?.get("transition") != null) add("window_motion")
    if ((spec["window"] as? JsonObject)?.get("backdrop") != null) add("backdrop")
    if ((spec["theme"] as? JsonObject)?.text("design") == "platform") add("design_platform")
    val colors = (spec["theme"] as? JsonObject)?.get("colors") as? JsonObject
    if (colors?.get("light") != null || colors?.get("dark") != null) add("theme_modes")
  }
}
