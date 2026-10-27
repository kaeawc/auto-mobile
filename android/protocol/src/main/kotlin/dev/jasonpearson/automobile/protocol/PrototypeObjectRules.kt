package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecContract.definitions
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator.MAX_PROTOTYPE_TEXT_SPANS
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object PrototypeObjectRules {
  fun visitObject(
    value: JsonElement,
    rule: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    val data = value as? JsonObject ?: return fail(path, "Expected object")
    textConstraint(data, rule, path)?.let {
      return it
    }
    val fields = rule.getValue("fields").jsonObject
    if (data.text("type") == "searchBar" && "child" in data && "activeKey" !in data)
      return fail("$path.child", "Search bar child requires activeKey")
    // `empty` tests a `/data` value (#14207); state key and `/platform` conditions have no
    // emptiness.
    if ("empty" in data && ("key" in data || "platform" in data))
      return fail("$path.empty", "empty applies only to data conditions")
    walkFields(data, fields, path, context, depth)?.let {
      return it
    }
    val kind = listOf("style", "fadeEdges", "imageFilter").firstOrNull { rule === definitions[it] }
    return PrototypeStylePolishV2Rules.objectError(data, kind ?: "", path)
      ?: objectConstraint(data, rule, path)
  }

  private fun walkFields(
    data: JsonObject,
    fields: JsonObject,
    path: String,
    context: Context,
    depth: Int,
  ): PrototypeSpecError? {
    for (key in (data.keys + fields.keys).sorted()) {
      val childPath = keyPath(path, key)
      val field = fields[key] as? JsonObject ?: return fail(childPath, "Unknown property")
      val child = data[key]
      if (child == null) {
        if (!field.flag("optional")) return fail(childPath, "Required property")
        continue
      }
      val error = walk(child, field.getValue("rule").jsonObject, childPath, context, depth)
      if (error != null) return error
    }
    return null
  }

  fun textConstraint(data: JsonObject, rule: JsonObject, path: String): PrototypeSpecError? {
    // Text constraints precede field walking, matching the host's first-error ordering.
    if (rule === definitions.getValue("node").jsonObject.getValue("variants").jsonObject["text"]) {
      val exactlyOne = rule.getValue("exactlyOne").jsonArray
      if (exactlyOne.count { data.containsKey(it.jsonPrimitive.content) } != 1) {
        val spans = data.containsKey("spans")
        return fail(
          keyPath(path, if (spans) "spans" else "text"),
          if (spans) "text and spans cannot both be set" else "text node needs text or spans",
        )
      }
      if ((data["spans"] as? JsonArray)?.size?.let { it > MAX_PROTOTYPE_TEXT_SPANS } == true)
        return fail(keyPath(path, "spans"), "Text span limit exceeded")
    }
    return null
  }

  fun objectConstraint(
    data: JsonObject,
    rule: JsonObject,
    path: String,
  ): PrototypeSpecError? {
    if (rule.flag("binding") && data.containsKey("pager") == data.containsKey("stateKey")) {
      return fail(keyPath(path, "pager"), "Exactly one of pager or stateKey is required")
    }
    val exclusive = rule["exclusive"] as? JsonArray
    if (exclusive != null && exclusive.count { data.containsKey(it.jsonPrimitive.content) } != 1) {
      return fail(
        keyPath(path, exclusive.first().jsonPrimitive.content),
        "Exactly one container selector is required",
      )
    }
    formConstraint(data, rule, path)?.let {
      return it
    }
    if (rule.flag("atLeastOne") && data.isEmpty())
      return fail(
        path,
        if (rule === definitions["semantics"]) "Expected at least one semantics field"
        else "At least one selector field is required",
      )
    return null
  }

  /**
   * Single-trigger dependents are optional; a pipe-separated trigger group requires exactly one.
   */
  fun formConstraint(
    data: JsonObject,
    rule: JsonObject,
    path: String,
  ): PrototypeSpecError? {
    val exactlyOne = (rule["exactlyOne"] as? JsonArray)?.map { it.jsonPrimitive.content }
    if (exactlyOne != null && exactlyOne.count { data.containsKey(it) } != 1) {
      return fail(
        if (rule.flag("exactlyOneAtObject")) path else keyPath(path, exactlyOne.first()),
        "Exactly one of ${exactlyOne.joinToString(", ")} is required",
      )
    }
    val dependents = rule["dependents"] as? JsonObject ?: return null
    for ((trigger, names) in dependents.toSortedMap()) {
      val fields = names.jsonArray.map { it.jsonPrimitive.content }
      val present = fields.filter { data.containsKey(it) }
      if (trigger.split("|").none { data.containsKey(it) }) {
        if (present.isNotEmpty())
          return fail(
            keyPath(path, present.first()),
            "Requires ${trigger.split("|").joinToString(" or ")}",
          )
      } else if ("|" in trigger && present.size != 1) {
        return fail(
          keyPath(path, present.getOrNull(1) ?: fields.first()),
          "Exactly one of ${fields.joinToString(", ")} is required",
        )
      }
    }
    return null
  }
}
