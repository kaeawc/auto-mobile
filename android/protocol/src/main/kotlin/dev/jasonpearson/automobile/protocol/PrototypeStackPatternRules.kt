package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/** Zoom sources are single authored nodes, distinct from visibility morph pairs. */
internal object PrototypeStackPatternRules {
  fun required(fields: JsonObject): Boolean =
    fields.text("type") in setOf("stack", "push", "replace") &&
      ("source" in fields ||
        fields.text("transition") in setOf("sharedAxisX", "sharedAxisY", "fadeThrough", "zoom"))

  private fun zooms(context: PrototypeStateChecks.Context): List<PrototypeStateChecks.Located> {
    val stacks =
      context.nodes
        .filter { it.value.text("type") == "stack" }
        .associate { it.value.text("id") to it.value.text("transition") }
    return context.actions.filter {
      it.value.text("type") in setOf("push", "replace") &&
        (it.value.text("transition") ?: stacks[it.value.text("stack")]) == "zoom"
    }
  }

  fun sources(context: PrototypeStateChecks.Context): Set<String> =
    zooms(context).mapNotNull { it.value.text("source") }.toSet()

  fun error(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    val actions = zooms(context)
    for ((action, path) in actions) {
      val source = action.text("source")
      if (source == null || context.nodes.count { it.value.text("sharedKey") == source } != 1)
        return fail("$path.source", "zoom requires source to resolve to exactly one sharedKey node")
    }
    for ((node, path) in context.nodes) {
      if (
        node.text("type") == "stack" &&
          node.text("transition") == "zoom" &&
          actions.none { it.value.text("stack") == node.text("id") }
      )
        return fail(
          "$path.transition",
          "zoom requires a push/replace action with a resolvable source",
        )
    }
    return null
  }
}
