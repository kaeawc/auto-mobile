package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

internal object PrototypeBarScrollRules {
  private fun screenScopes(context: Context): List<String> {
    val scopes = mutableListOf("root")
    for ((node, path) in context.nodes) {
      for (name in (node["screens"] as? JsonObject).orEmpty().keys) {
        scopes.add("$path.screens[${PrototypeSpecInput.canonicalString(name)}]")
      }
    }
    return scopes
  }

  fun error(context: Context): PrototypeSpecError? {
    val scopes = screenScopes(context)
    fun scope(path: String) =
      scopes.filter { path == it || path.startsWith("$it.") }.maxByOrNull { it.length }
    for ((node, path) in context.nodes) {
      if (node.text("type") !in setOf("topAppBar", "bottomNav", "tabBar")) continue
      val active = node.text("onScroll")?.let { it !in setOf("none", "pinned") } == true
      if (node["scroll"] == null && !active) continue
      val target = node.text("scroll")
      val count =
        context.nodes.count { (other, at) ->
          other.text("type") == "scroll" && other.text("id") == target && scope(at) == scope(path)
        }
      if (target == null || count != 1)
        return fail("$path.scroll", "Expected one scroll id in the same screen")
    }
    return null
  }
}
