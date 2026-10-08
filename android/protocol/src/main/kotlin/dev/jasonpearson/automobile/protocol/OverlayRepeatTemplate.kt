package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One piece of a string with `{as.field}` / `{index}` placeholders resolved into segments. */
sealed interface OverlayRepeatSegment {
  data class Literal(val text: String) : OverlayRepeatSegment

  data object Index : OverlayRepeatSegment

  data class Field(val name: String) : OverlayRepeatSegment
}

/**
 * The placeholder grammar of `repeat` list templates, shared by the validator and the renderer.
 * Tokens are found by a plain string scan rather than a regex (Android's ICU engine rejects a lone
 * `}` that the desktop JVM accepts, #9947). `{index}` and `{<as>.<field>}` are placeholders; any
 * other brace text, including `{state_key}`, is left for the ordinary state interpolation.
 */
object OverlayRepeatTemplate {
  fun segments(text: String, alias: String): List<OverlayRepeatSegment> {
    val segments = mutableListOf<OverlayRepeatSegment>()
    val literal = StringBuilder()
    var index = 0
    while (index < text.length) {
      val close = if (text[index] == '{') text.indexOf('}', index + 1) else -1
      val token = if (close < 0) null else token(text.substring(index + 1, close), alias)
      if (token == null) {
        literal.append(text[index])
        index++
      } else {
        if (literal.isNotEmpty()) segments.add(OverlayRepeatSegment.Literal(literal.toString()))
        literal.clear()
        segments.add(token)
        index = close + 1
      }
    }
    if (literal.isNotEmpty()) segments.add(OverlayRepeatSegment.Literal(literal.toString()))
    return segments
  }

  fun fieldReferences(text: String, alias: String): List<String> =
    segments(text, alias).filterIsInstance<OverlayRepeatSegment.Field>().map { it.name }

  private fun token(inner: String, alias: String): OverlayRepeatSegment? {
    if (inner == "index") return OverlayRepeatSegment.Index
    val prefix = "$alias."
    val field = inner.removePrefix(prefix)
    return if (inner.startsWith(prefix) && isFieldName(field)) OverlayRepeatSegment.Field(field)
    else null
  }

  private fun isFieldName(name: String): Boolean =
    name.length in 1..64 &&
      (name[0] in 'A'..'Z' || name[0] in 'a'..'z' || name[0] == '_') &&
      name.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' }
}

/**
 * Static checks for `repeat` on an already structurally valid spec, mirroring the TypeScript
 * validator: placeholders name a field every item has, a template holds no nested `repeat` or
 * pager, and the expanded tree still fits the node and image limits. Depth is unchanged because
 * instances are siblings.
 */
internal object OverlayRepeatValidator {
  private data class Scope(val alias: String, val items: List<JsonObject>)

  private data class Child(val node: JsonObject, val path: String)

  private class Budget(var nodes: Int = 0, var images: Int = 0)

  fun validate(spec: JsonElement): OverlaySpecError? {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return null
    return templateErrors(root, "root", null) ?: expandedErrors(root, "root", Budget(), null)
  }

  private fun fail(path: String, message: String) = OverlaySpecError(path, message)

  private fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun checkString(value: JsonElement?, path: String, scope: Scope): OverlaySpecError? {
    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    for (name in OverlayRepeatTemplate.fieldReferences(text, scope.alias)) {
      if (!scope.items.all { it.containsKey(name) }) {
        return fail(path, "Unknown repeat field ${JsonPrimitive(name)}")
      }
    }
    return null
  }

  /** An emit name must stay non-empty for every item once its placeholders are bound. */
  private fun checkEmitName(value: JsonElement?, path: String, scope: Scope): OverlaySpecError? {
    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val segments = OverlayRepeatTemplate.segments(text, scope.alias)
    val empty =
      scope.items.indexOfFirst { item ->
        segments.all { segment ->
          when (segment) {
            is OverlayRepeatSegment.Literal -> segment.text.isEmpty()
            is OverlayRepeatSegment.Index -> false
            is OverlayRepeatSegment.Field ->
              (item[segment.name] as? JsonPrimitive)?.content.orEmpty().isEmpty()
          }
        }
      }
    return if (empty < 0) null else fail(path, "Expanded emit name is empty for item $empty")
  }

  private fun checkCondition(value: JsonElement?, path: String, scope: Scope): OverlaySpecError? {
    val condition = value as? JsonObject ?: return null
    checkString(condition["equals"], "$path.equals", scope)?.let {
      return it
    }
    checkString(condition["notEquals"], "$path.notEquals", scope)?.let {
      return it
    }
    checkCondition(condition["not"], "$path.not", scope)?.let {
      return it
    }
    for (form in listOf("all", "any")) {
      val members = condition[form] as? JsonArray ?: continue
      for ((index, member) in members.withIndex()) {
        checkCondition(member, "$path.$form[$index]", scope)?.let {
          return it
        }
      }
    }
    return null
  }

  private fun checkAction(value: JsonElement, path: String, scope: Scope): OverlaySpecError? {
    val action = value as? JsonObject ?: return null
    return when (action.text("type")) {
      "setState" -> checkString(action["value"], "$path.value", scope)
      "emit" ->
        checkString(action["name"], "$path.name", scope)
          ?: checkEmitName(action["name"], "$path.name", scope)
      else -> null
    }
  }

  private fun checkOwnFields(node: JsonObject, path: String, scope: Scope): OverlaySpecError? {
    if (node.text("type") == "text") {
      checkString(node["text"], "$path.text", scope)?.let {
        return it
      }
    }
    checkCondition(node["visibleWhen"], "$path.visibleWhen", scope)?.let {
      return it
    }
    for ((index, entry) in (node["styleWhen"] as? JsonArray).orEmpty().withIndex()) {
      val condition = (entry as? JsonObject)?.get("when")
      checkCondition(condition, "$path.styleWhen[$index].when", scope)?.let {
        return it
      }
    }
    for ((index, action) in (node["onTap"] as? JsonArray).orEmpty().withIndex()) {
      checkAction(action, "$path.onTap[$index]", scope)?.let {
        return it
      }
    }
    return null
  }

  private fun childrenOf(node: JsonObject, path: String): List<Child> {
    (node["child"] as? JsonObject)?.let {
      return listOf(Child(it, "$path.child"))
    }
    return (node["children"] as? JsonArray).orEmpty().mapIndexedNotNull { index, entry ->
      (entry as? JsonObject)?.let { Child(it, "$path.children[$index]") }
    }
  }

  private fun scopeOf(node: JsonObject): Scope? {
    val repeat = node["repeat"] as? JsonObject ?: return null
    val alias = repeat.text("as") ?: return null
    val items = (repeat["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    return Scope(alias, items)
  }

  private fun templateErrors(node: JsonObject, path: String, scope: Scope?): OverlaySpecError? {
    if (scope != null) {
      if (node.containsKey("repeat")) return fail("$path.repeat", "Nested repeat is not supported")
      if (node.text("type") == "pager")
        return fail(path, "Pager cannot appear inside a repeat template")
      checkOwnFields(node, path, scope)?.let {
        return it
      }
    }
    val childScope = scopeOf(node) ?: scope
    for (child in childrenOf(node, path)) {
      templateErrors(child.node, child.path, childScope)?.let {
        return it
      }
    }
    return null
  }

  private fun imageUses(node: JsonObject): Int =
    if (node.text("type") == "image") 1
    else
      (node["items"] as? JsonArray).orEmpty().count { (it as? JsonObject)?.text("image") != null }

  /** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
  private fun expandedErrors(
    node: JsonObject,
    path: String,
    budget: Budget,
    repeatPath: String?,
  ): OverlaySpecError? {
    val at = repeatPath ?: path
    if (++budget.nodes > OverlaySpecValidator.MAX_OVERLAY_NODES)
      return fail(at, "Expanded node limit exceeded")
    budget.images += imageUses(node)
    if (budget.images > OverlaySpecValidator.MAX_OVERLAY_IMAGES)
      return fail(at, "Expanded image limit exceeded")
    val scope = scopeOf(node)
    val nestedPath = if (scope != null) "$path.repeat" else repeatPath
    repeat(scope?.items?.size ?: 1) {
      for (child in childrenOf(node, path)) {
        expandedErrors(child.node, child.path, budget, nestedPath)?.let {
          return it
        }
      }
    }
    return null
  }
}
