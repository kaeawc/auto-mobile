package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.fail
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatLiteralChecks.checkLiteralKeys
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.RepeatState
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.checkOwnFields
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

internal object PrototypeRepeatTree {
  data class Child(val node: JsonObject, val path: String)

  class Budget(
    var nodes: Int = 0,
    var images: Int = 0,
    var effects: Int = 0,
    var animatedEffects: Int = 0,
  )

  fun childrenOf(node: JsonObject, path: String): List<Child> = buildList {
    for ((key, value) in node) when {
      key == "child" || (node.text("type") == "list" && key in setOf("header", "footer")) ->
        (value as? JsonObject)?.let { add(Child(it, "$path.$key")) }
      key == "children" ->
        (value as? JsonArray).orEmpty().forEachIndexed { index, child ->
          (child as? JsonObject)?.let { add(Child(it, "$path.children[$index]")) }
        }
      key == "screens" ->
        (value as? JsonObject).orEmpty().forEach { (name, child) ->
          (child as? JsonObject)?.let { add(Child(it, "$path.screens[${JsonPrimitive(name)}]")) }
        }
    }
  }

  fun scopeOf(node: JsonObject, path: String, data: PrototypeRepeatData): Scope? {
    val repeat = node["repeat"] as? JsonObject ?: return null
    val alias = repeat.text("as") ?: return null
    val source = repeat["items"] as? JsonObject
    val pointer = source?.text("path")
    val items =
      if (pointer != null) data.items(pointer)
      else (repeat["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    val names = (repeat["derive"] as? JsonObject)?.keys.orEmpty()
    // Only copy rows when derived fields are added; the projected list is otherwise shared.
    val projected =
      if (names.isEmpty()) items
      else items.map { JsonObject(it + names.associateWith { JsonPrimitive("") }) }
    return Scope(path, alias, projected, source != null, names)
  }

  fun repeatSourceError(
    node: JsonObject,
    path: String,
    state: RepeatState,
  ): PrototypeSpecError? {
    val source = (node["repeat"] as? JsonObject)?.get("items") as? JsonObject ?: return null
    val pointer = source.text("path") ?: return null
    val at = "$path.repeat.items.path"
    val items =
      state.data.source(pointer) ?: return fail(at, "Repeat path does not resolve to an array")
    val maximum =
      if (node.text("type") == "list") PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS
      else PrototypeSpecValidator.maxRepeatItems
    if (items.size > maximum) return fail(at, "Repeat path resolves to more than $maximum items")
    val maxItems = (node["maxItems"] as? JsonPrimitive)?.doubleOrNull
    if (node.text("type") == "list" && maxItems != null && items.size > maxItems)
      return fail(at, "List data has more items than maxItems")
    val invalid = items.indexOfFirst { it !is JsonObject }
    if (invalid >= 0) return fail(at, "Repeat path item $invalid is not an object")
    state.cells += state.data.cells(pointer)
    return if (state.cells > PrototypeSpecValidator.MAX_PROTOTYPE_REPEAT_PATH_CELLS)
      fail(at, "Repeat path cell limit exceeded")
    else null
  }

  fun repeatKeyError(node: JsonObject, path: String, scope: Scope?): PrototypeSpecError? {
    val key = (node["repeat"] as? JsonObject)?.text("key") ?: return null
    if (scope == null) return null
    val at = "$path.repeat.key"
    if (scope.items.any { !it.containsKey(key) }) {
      return fail(at, "Unknown repeat field ${JsonPrimitive(key)}")
    }
    if (key in scope.derivedNames) return null
    val seen = mutableMapOf<String, Int>()
    val numbers = mutableMapOf<Double, Int>()
    for ((index, item) in scope.items.withIndex()) {
      val value = item.getValue(key).jsonPrimitive
      val text = PrototypeRepeatTemplate.rendered(value)
      val number = value.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
      val first = listOfNotNull(seen[text], number?.let { numbers[it] }).minOrNull()
      if (first != null) {
        val original =
          PrototypeRepeatTemplate.rendered(scope.items[first].getValue(key).jsonPrimitive)
        return fail(at, "Duplicate repeat key ${JsonPrimitive(original)} (items $first and $index)")
      }
      seen[text] = index
      if (number != null) numbers[number] = index
    }
    return null
  }

  fun templateErrors(
    node: JsonObject,
    path: String,
    scope: Scope?,
    state: RepeatState,
  ): PrototypeSpecError? {
    if (scope != null) {
      if (node.text("type") == "list")
        return fail(path, "A list cannot sit inside a repeat template")
      if (node.containsKey("repeat")) return fail("$path.repeat", "Nested repeat is not supported")
      if (node.text("type") == "pager")
        return fail(path, "Pager cannot appear inside a repeat template")
      if (node.text("type") == "stack")
        return fail(path, "Stack cannot appear inside a repeat template")
    }
    val own =
      if (scope != null) checkOwnFields(node, path, scope, state)
      else checkLiteralKeys(node, path, state)
    if (own != null) return own
    repeatSourceError(node, path, state)?.let {
      return it
    }
    val ownScope = scopeOf(node, path, state.data)
    val childScope = ownScope ?: scope
    for (child in childrenOf(node, path)) {
      templateErrors(
          child.node,
          child.path,
          if (node.text("type") == "list" && !child.path.startsWith("$path.children[")) scope
          else childScope,
          state,
        )
        ?.let {
          return it
        }
    }
    return repeatKeyError(node, path, ownScope)
  }

  fun imageUses(node: JsonObject): Int =
    if (node.text("type") == "image") maxOf(1, prototypeImageSlotUses(node["asset"]))
    else
      (node["items"] as? JsonArray).orEmpty().sumOf {
        prototypeImageSlotUses((it as? JsonObject)?.get("image"))
      }

  /** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
  fun expandedErrors(
    node: JsonObject,
    path: String,
    budget: Budget,
    repeatPath: String?,
    data: PrototypeRepeatData,
  ): PrototypeSpecError? {
    val at = repeatPath ?: path
    if (++budget.nodes > PrototypeSpecValidator.MAX_PROTOTYPE_NODES)
      return fail(at, "Expanded node limit exceeded")
    budget.images += imageUses(node)
    if (budget.images > PrototypeSpecValidator.MAX_PROTOTYPE_IMAGES)
      return fail(at, "Expanded image limit exceeded")
    PrototypeEffectRules.chargeExpanded(node, at, budget)?.let {
      return it
    }
    val scope = scopeOf(node, path, data)
    val nestedPath = if (scope != null) "$path.repeat" else repeatPath
    repeat(if (node.text("type") == "list") 1 else scope?.items?.size ?: 1) {
      for (child in childrenOf(node, path)) {
        expandedErrors(child.node, child.path, budget, nestedPath, data)?.let {
          return it
        }
      }
    }
    return null
  }
}
