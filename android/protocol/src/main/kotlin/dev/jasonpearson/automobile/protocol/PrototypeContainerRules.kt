package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.insideScroll
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.insideVerticalScroll
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.jsonObject

internal object PrototypeContainerRules {
  fun stackErrors(context: Context): PrototypeSpecError? {
    val stacks = mutableMapOf<String, JsonObject>()
    for ((value, path) in context.nodes) {
      if (value.text("type") != "stack") continue
      val id = checkNotNull(value.text("id"))
      if (stacks.containsKey(id)) return fail("$path.id", "Duplicate stack id")
      val screens = value.getValue("screens").jsonObject
      val start = checkNotNull(value.text("start"))
      if (!screens.containsKey(start)) return fail("$path.start", "Unknown start screen")
      stacks[id] = screens
    }
    for ((value, path) in context.actions) {
      val id = value.text("stack") ?: continue
      val screens = stacks[id] ?: return fail("$path.stack", "Unknown stack id")
      val screen = value.text("screen")
      if (screen != null && !screens.containsKey(screen))
        return fail("$path.screen", "Unknown stack screen")
    }
    return null
  }

  /** A swipe needs an action side, and a horizontal pager or carousel would steal its drag. */
  fun swipeActionsErrors(context: Context): PrototypeSpecError? {
    for ((value, path) in context.nodes) {
      val swipe = value["swipeActions"] as? JsonObject ?: continue
      if (!swipe.containsKey("start") && !swipe.containsKey("end"))
        return fail("$path.swipeActions", "swipeActions needs start or end")
      val blocked =
        context.nodes.any { (ancestor, ancestorPath) ->
          path.startsWith("$ancestorPath.") &&
            (ancestor.text("type") == "carousel" ||
              (ancestor.text("type") == "pager" && ancestor.text("axis") != "vertical"))
        }
      if (blocked)
        return fail(
          "$path.swipeActions",
          "swipeActions cannot appear inside a horizontal pager or carousel",
        )
    }
    return null
  }

  fun pagerErrors(context: Context): PrototypeSpecError? {
    val pagers = mutableSetOf<String>()
    for ((value, path) in context.nodes) {
      horizontalLazyError(value, path, context)?.let {
        return it
      }
      if (value.text("type") != "pager") continue
      val id = checkNotNull(value.text("id"))
      if (!pagers.add(id)) return fail("$path.id", "Duplicate pager id")
      if (value.text("axis") == "vertical" && insideVerticalScroll(context, path))
        return fail("$path.axis", "A vertical pager cannot appear inside a vertical scroll")
    }
    for ((value, path) in context.nodes + context.actions) {
      val pager = value.text("pager") ?: continue
      if (!pagers.contains(pager)) return fail("$path.pager", "Unknown pager id")
    }
    return pagerContextErrors(context, pagers)
  }

  /**
   * A horizontal `scroll` measures its child with an infinite width, which the lazy horizontal
   * pager and carousel layouts cannot take (#14165).
   */
  private fun horizontalLazyError(
    value: JsonObject,
    path: String,
    context: Context,
  ): PrototypeSpecError? {
    val type = value.text("type")
    val lazy = type == "carousel" || (type == "pager" && value.text("axis") != "vertical")
    if (!lazy || !insideScroll(context, path, horizontal = true)) return null
    return if (type == "carousel") fail(path, "A carousel cannot appear inside a horizontal scroll")
    else fail(path, "A horizontal pager cannot appear inside a horizontal scroll")
  }

  fun pagerContextErrors(context: Context, pagers: Set<String>): PrototypeSpecError? {
    for ((value, path) in context.actions) {
      for ((name, binding) in (value["context"] as? JsonObject).orEmpty()) {
        val page = (binding as? JsonObject)?.text("page") ?: continue
        if (page !in pagers) return fail(keyPath("$path.context", name), "Unknown pager id")
      }
    }
    return null
  }
}
