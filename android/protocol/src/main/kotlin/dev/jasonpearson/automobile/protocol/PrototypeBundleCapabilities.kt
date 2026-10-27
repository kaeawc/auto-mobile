package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.text
import kotlinx.serialization.json.*

/** Advisory requirements, reusing the validator's authored action and bindable-field collection. */
internal object PrototypeBundleCapabilities {
  fun required(refs: PrototypeBundleReferences): List<String> {
    val spec = refs.spec
    val caps = linkedSetOf<String>()
    specContent(spec, caps)
    specPresentation(spec, caps)
    for (node in PrototypeBundleSpec.nodes(spec)) {
      if (node["type"] == JsonPrimitive("pager") && "stateKey" in node)
        caps.add("prototype_pager_state_key_v1")
      caps.addAll(PrototypeBundleNodeCapabilities.collect(node))
      if (PrototypeStringConditions.uses(node)) caps.add("prototype_string_conditions_v1")
      fields(node, caps)
    }
    for (action in refs.context.actions) actions(action.value, caps)
    platform(refs, caps)
    return caps.sorted()
  }

  /** Strings, data, storage and formatting: what the spec carries rather than how it looks. */
  private fun specContent(spec: JsonObject, caps: MutableSet<String>) {
    if ("strings" in spec || PrototypeStrings.fields(spec).any { "{t:" in it.text })
      caps.add("prototype_strings_v1")
    if ("data" in spec) caps.add("prototype_data_model_v1")
    if ("storage" in spec) caps.add("prototype_storage_v1")
    if ("derive" in spec) caps.add("prototype_format_v1")
  }

  /** Window and theme level presentation: namespaces, motion, backdrop, design and mode colours. */
  private fun specPresentation(spec: JsonObject, caps: MutableSet<String>) {
    for (key in listOf("window", "theme")) {
      val block = spec[key] as? JsonObject ?: continue
      if ("ios" in block || "android" in block) caps.add("prototype_platform_namespace_v1")
    }
    if (text(spec["motion"]) == "reduced") caps.add("prototype_reduced_motion_v1")
    if ((spec["window"] as? JsonObject)?.get("transition") != null)
      caps.add("prototype_window_motion_v1")
    if (((spec["window"] as? JsonObject)?.get("backdrop")) != null)
      caps.add("prototype_backdrop_v1")
    if (text((spec["theme"] as? JsonObject)?.get("design")) == "platform") {
      caps.add("prototype_design_platform_v1")
    }
    val colors = (spec["theme"] as? JsonObject)?.get("colors") as? JsonObject
    val scrim = (((spec["window"] as? JsonObject)?.get("placement") as? JsonObject)?.get("scrim"))
    if (
      colors?.keys?.any { it in setOf("light", "dark") } == true ||
        PrototypeBundleNodeCapabilities.themed(scrim)
    )
      caps.add("prototype_theme_modes_v1")
  }

  private fun actions(action: JsonObject, caps: MutableSet<String>) {
    when (text(action["type"])) {
      "request" -> {
        if ("append" in action) {
          caps.add("prototype_lazy_list_v1")
          caps.add("prototype_data_model_v1")
        }
        caps.add("prototype_network_v1")
        if (text(action["via"]) == "device") caps.add("prototype_network_device_v1")
      }
      "prependData" -> {
        caps.add("prototype_data_actions_v1")
        caps.add("prototype_lazy_list_v1")
      }
      "setData",
      "appendData",
      "removeData" -> caps.add("prototype_data_actions_v1")
      "startTimer",
      "cancelTimer" -> caps.add("prototype_timers_v1")
      "push",
      "replace" -> if ("transition" in action) caps.add("prototype_stack_transitions_v1")
      "scrollTo" -> caps.add("prototype_chat_scroll_v1")
      "emit" -> if ("context" in action) caps.add("prototype_emit_context_v1")
    }
  }

  private fun fields(node: JsonObject, caps: MutableSet<String>) {
    if ("onAppear" in node) caps.add("prototype_timers_v1")
    val checks = setOf("checks", "validateOn", "enabledWhen", "valid", "requireValid")
    if (hasField(node, checks, setOf("payload", "data", "state", "repeat")))
      caps.add("prototype_checks_v1")
    if (
      hasField(
        node,
        setOf("empty", "shimmer"),
        setOf("child", "children", "screens", "payload", "repeat", "data"),
      )
    )
      caps.add("prototype_loading_states_v1")
    val repeat = node["repeat"] as? JsonObject
    if (repeat?.containsKey("derive") == true) caps.add("prototype_format_v1")
    if (repeat?.let { "key" in it || it["items"] is JsonObject } == true)
      caps.add("prototype_data_model_v1")
    PrototypeBindableFields.first<Unit>(node, "") { value, _, kind ->
      val bound =
        when (kind) {
          PrototypeBindableKind.TEXT -> text(value)?.let(PrototypeDataText::hasBinding) == true
          PrototypeBindableKind.EMIT_BINDING -> text((value as? JsonObject)?.get("data")) != null
          else -> false
        }
      if (bound) caps.add("prototype_data_model_v1")
      null
    }
    val conditions =
      listOfNotNull(node["enabledWhen"], node["visibleWhen"], node["errorWhen"]) +
        (node["styleWhen"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.get("when") }
    if (conditions.any { hasField(it, setOf("data"), emptySet()) })
      caps.add("prototype_data_model_v1")
  }

  private fun hasField(value: JsonElement, names: Set<String>, skipped: Set<String>): Boolean =
    when (value) {
      is JsonObject ->
        value.any { (key, child) ->
          key !in skipped && (key in names || hasField(child, names, skipped))
        }
      is JsonArray -> value.any { hasField(it, names, skipped) }
      else -> false
    }

  private fun platform(refs: PrototypeBundleReferences, caps: MutableSet<String>) {
    val declared = ((refs.spec["requires"] as? JsonObject)?.get("platform") as? JsonArray).orEmpty()
    if (declared.isNotEmpty() || "platform" in refs.spec) caps.add("prototype_platform_v1")
    for (name in declared) {
      text(name)
        ?.let { text(PrototypePlatformModules.module(it)?.get("capability")) }
        ?.let(caps::add)
    }
    val uses = PrototypePlatformUses.uses(refs.spec, refs.context)
    if (uses.isNotEmpty()) caps.add("prototype_platform_v1")
    for (use in uses) {
      val module =
        when (use) {
          is PrototypePlatformUses.Use.Handler -> PrototypePlatformModules.eventModule(use.event)
          is PrototypePlatformUses.Use.Call ->
            PrototypePlatformModules.callDefinition(text(use.action["call"]))?.first
          is PrototypePlatformUses.Use.Read -> PrototypePlatformModules.pointerModule(use.pointer)
          is PrototypePlatformUses.Use.Event -> null
        }
      module?.let { text(PrototypePlatformModules.module(it)?.get("capability")) }?.let(caps::add)
    }
  }
}
