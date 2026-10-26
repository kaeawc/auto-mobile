package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Semantic rules beyond the shared structural contract. */
internal object PrototypeLazyListRules {
  fun error(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      val type = node.text("type")
      if (type !in setOf("list", "scroll")) continue
      val ancestors = context.nodes.filter { path.startsWith("${it.path}.") }
      val axis = node.text("axis") ?: "vertical"
      val message =
        if (type == "list") listError(path, axis, ancestors)
        else if (
          ancestors.any {
            it.value.text("type") == "list" && (it.value.text("axis") ?: "vertical") == axis
          }
        )
          "A scroll cannot sit inside a list on the same axis"
        else null
      if (message != null) return PrototypeSpecError(path, message)
      if (type == "list" && "endThreshold" in node && "onEndReached" !in node)
        return PrototypeSpecError("$path.endThreshold", "endThreshold needs onEndReached")
    }
    return null
  }

  private fun listError(
    path: String,
    axis: String,
    ancestors: List<PrototypeStateChecks.Located>,
  ): String? =
    when {
      ancestors.any { it.value.text("type") == "list" } -> "A list cannot sit inside another list"
      ancestors.any { "repeat" in it.value && path.startsWith("${it.path}.children[") } ->
        "A list cannot sit inside a repeat template"
      ancestors.any {
        it.value.text("type") == "scroll" && (it.value.text("axis") ?: "vertical") == axis
      } -> "A list cannot sit inside a scroll on the same axis"
      else -> null
    }

  fun limitError(spec: JsonElement): PrototypeSpecError? {
    val data = (spec as? JsonObject)?.get("data") as? JsonObject
    return nodes(spec).firstNotNullOfOrNull { (node, path) ->
      val pointer = ((node["repeat"] as? JsonObject)?.get("items") as? JsonObject)?.text("path")
      val source = pointer?.let { PrototypeDataPointer.resolve(data, it) } as? JsonArray
      if (
        node.text("type") == "list" &&
          source != null &&
          source.size > PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS
      )
        PrototypeSpecError(
          "$path.repeat.items.path",
          "Repeat path resolves to more than ${PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS} items",
        )
      else null
    }
  }

  fun nodes(spec: JsonElement): List<PrototypeRepeatTree.Child> {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return emptyList()
    val result = mutableListOf<PrototypeRepeatTree.Child>()
    val pending = ArrayDeque<PrototypeRepeatTree.Child>()
    pending.add(PrototypeRepeatTree.Child(root, "root"))
    while (pending.isNotEmpty()) {
      val child = pending.removeLast()
      result.add(child)
      pending.addAll(PrototypeRepeatTree.childrenOf(child.node, child.path).asReversed())
    }
    return result
  }
}

/** The smallest authored window among lists sharing the exact `/data` write target. */
fun prototypeListMaxItemsFor(spec: JsonElement, dataPath: String): Int? =
  PrototypeLazyListRules.nodes(spec)
    .mapNotNull { (node, _) ->
      val source = ((node["repeat"] as? JsonObject)?.get("items") as? JsonObject)?.text("path")
      if (node.text("type") == "list" && "/data$source" == dataPath)
        (node["maxItems"] as? JsonPrimitive)?.intOrNull
      else null
    }
    .minOrNull()

fun prototypeListMaxItemsFor(spec: PrototypeSpec, dataPath: String): Int? =
  prototypeListMaxItemsFor(PrototypeSpecValidator.json.encodeToJsonElement(spec), dataPath)
