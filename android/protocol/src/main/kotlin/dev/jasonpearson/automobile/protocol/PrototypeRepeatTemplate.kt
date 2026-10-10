package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** One piece of a string with `{as.field}` / `{index}` placeholders resolved into segments. */
sealed interface PrototypeRepeatSegment {
  data class Literal(val text: String) : PrototypeRepeatSegment

  data object Index : PrototypeRepeatSegment

  data class Field(val name: String) : PrototypeRepeatSegment
}

/**
 * The placeholder grammar of `repeat` list templates, shared by the validator and the renderer.
 * Tokens are found by a plain string scan rather than a regex (Android's ICU engine rejects a lone
 * `}` that the desktop JVM accepts, #9947). `{index}` and `{<as>.<field>}` are placeholders; any
 * other brace text, including `{state_key}`, is left for the ordinary state interpolation.
 */
object PrototypeRepeatTemplate {
  fun segments(text: String, alias: String): List<PrototypeRepeatSegment> {
    val segments = mutableListOf<PrototypeRepeatSegment>()
    val literal = StringBuilder()
    var index = 0
    while (index < text.length) {
      val close = if (text[index] == '{') text.indexOf('}', index + 1) else -1
      val token = if (close < 0) null else token(text.substring(index + 1, close), alias)
      if (token == null) {
        literal.append(text[index])
        index++
      } else {
        if (literal.isNotEmpty()) segments.add(PrototypeRepeatSegment.Literal(literal.toString()))
        literal.clear()
        segments.add(token)
        index = close + 1
      }
    }
    if (literal.isNotEmpty()) segments.add(PrototypeRepeatSegment.Literal(literal.toString()))
    return segments
  }

  fun fieldReferences(text: String, alias: String): List<String> =
    segments(text, alias).filterIsInstance<PrototypeRepeatSegment.Field>().map { it.name }

  private fun token(inner: String, alias: String): PrototypeRepeatSegment? {
    if (inner == "index") return PrototypeRepeatSegment.Index
    val prefix = "$alias."
    val field = inner.removePrefix(prefix)
    return if (inner.startsWith(prefix) && isFieldName(field)) PrototypeRepeatSegment.Field(field)
    else null
  }

  /**
   * A state-key field: a literal key, or key characters mixed with at least one `{index}` or
   * `{alias.field}` placeholder that must bind to a literal key per instance (#11051). Scanned
   * rather than matched with a regex, like [segments].
   */
  fun isBoundKey(text: String): Boolean {
    if (isFieldName(text)) return true
    var placeholders = 0
    var index = 0
    while (index < text.length) {
      val character = text[index]
      if (character == '{') {
        val close = text.indexOf('}', index + 1)
        if (close < 0 || !isPlaceholder(text.substring(index + 1, close))) return false
        placeholders++
        index = close + 1
      } else if (isKeyCharacter(character)) {
        index++
      } else {
        return false
      }
    }
    return placeholders > 0
  }

  /** [text] with `{index}` and `{alias.field}` bound to one item; unknown fields stay literal. */
  fun bind(text: String, alias: String, item: Map<String, JsonElement>, index: Int): String =
    segments(text, alias).joinToString("") { segment ->
      when (segment) {
        is PrototypeRepeatSegment.Literal -> segment.text
        is PrototypeRepeatSegment.Index -> index.toString()
        is PrototypeRepeatSegment.Field ->
          (item[segment.name] as? JsonPrimitive)?.let(::rendered) ?: "{$alias.${segment.name}}"
      }
    }

  /** Integral numbers render without a decimal point or exponent at any magnitude. */
  fun rendered(value: JsonPrimitive): String {
    if (value.isString) return value.content
    val number = value.doubleOrNull
    return if (number != null && number.isFinite() && number == Math.floor(number))
      java.math.BigDecimal(number).toPlainString()
    else value.content
  }

  private fun isPlaceholder(inner: String): Boolean {
    if (inner == "index") return true
    val dot = inner.indexOf('.')
    return dot > 0 && isFieldName(inner.substring(0, dot)) && isFieldName(inner.substring(dot + 1))
  }

  private fun isKeyCharacter(character: Char): Boolean =
    character in 'A'..'Z' || character in 'a'..'z' || character in '0'..'9' || character == '_'

  fun isFieldName(name: String): Boolean =
    name.length in 1..64 &&
      (name[0] in 'A'..'Z' || name[0] in 'a'..'z' || name[0] == '_') &&
      name.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' }
}

/** How a bindable field binds; mirrors `FieldKind` in the TypeScript `prototypeTemplate.ts`. */
internal enum class PrototypeBindableKind {
  TEXT,
  OPERAND,
  EMIT_NAME,
  KEY,
}

/**
 * Visits a node's own bindable fields (not its children) in the same order as the TypeScript
 * `mapBindableFields`: `text`, component fields, `visibleWhen`, `styleWhen`, `onTap`, then the
 * state-key fields. Stops at the first non-null result of [visit].
 */
internal object PrototypeBindableFields {
  fun <T : Any> first(
    node: JsonObject,
    path: String,
    visit: (JsonElement?, String, PrototypeBindableKind) -> T?,
  ): T? {
    val visitor = Visitor(visit)
    return visitor.node(node, path)
  }

  private class Visitor<T : Any>(
    val visit: (JsonElement?, String, PrototypeBindableKind) -> T?,
  ) {
    fun field(data: JsonObject, key: String, path: String, kind: PrototypeBindableKind): T? =
      data[key]?.let { visit(it, "$path.$key", kind) }

    fun objects(data: JsonObject, key: String, path: String): List<Pair<JsonObject, String>> =
      (data[key] as? JsonArray).orEmpty().mapIndexedNotNull { index, entry ->
        (entry as? JsonObject)?.let { it to "$path.$key[$index]" }
      }

    fun condition(value: JsonElement?, path: String): T? {
      val condition = value as? JsonObject ?: return null
      field(condition, "key", path, PrototypeBindableKind.KEY)?.let {
        return it
      }
      field(condition, "equals", path, PrototypeBindableKind.OPERAND)?.let {
        return it
      }
      field(condition, "notEquals", path, PrototypeBindableKind.OPERAND)?.let {
        return it
      }
      condition(condition["not"], "$path.not")?.let {
        return it
      }
      for (form in listOf("all", "any")) {
        for ((member, memberPath) in objects(condition, form, path)) {
          condition(member, memberPath)?.let {
            return it
          }
        }
      }
      return null
    }

    fun action(action: JsonObject, path: String): T? =
      when ((action["type"] as? JsonPrimitive)?.content) {
        "setState" ->
          field(action, "key", path, PrototypeBindableKind.KEY)
            ?: field(action, "value", path, PrototypeBindableKind.OPERAND)
        "emit" -> field(action, "name", path, PrototypeBindableKind.EMIT_NAME)
        "toggle",
        "increment",
        "decrement" -> field(action, "key", path, PrototypeBindableKind.KEY)
        else -> null
      }

    fun actions(data: JsonObject, path: String): T? {
      for ((action, actionPath) in objects(data, "onTap", path)) {
        action(action, actionPath)?.let {
          return it
        }
      }
      return null
    }

    /** A `{label, onTap?}` part (dialog or snackbar button, app bar action). */
    fun part(value: JsonElement?, path: String): T? {
      val part = value as? JsonObject ?: return null
      return field(part, "label", path, PrototypeBindableKind.TEXT) ?: actions(part, path)
    }

    fun component(node: JsonObject, path: String): T? =
      when ((node["type"] as? JsonPrimitive)?.content) {
        "button",
        "fab" -> field(node, "label", path, PrototypeBindableKind.TEXT)
        "segmentedButton" ->
          objects(node, "options", path).firstNotNullOfOrNull { (option, optionPath) ->
            field(option, "label", optionPath, PrototypeBindableKind.TEXT)
          }
        "topAppBar" ->
          field(node, "title", path, PrototypeBindableKind.TEXT)
            ?: part(node["navigationIcon"], "$path.navigationIcon")
            ?: objects(node, "actions", path).firstNotNullOfOrNull { (entry, entryPath) ->
              part(entry, entryPath)
            }
        "dialog" ->
          field(node, "title", path, PrototypeBindableKind.TEXT)
            ?: field(node, "text", path, PrototypeBindableKind.TEXT)
            ?: part(node["confirm"], "$path.confirm")
            ?: part(node["dismiss"], "$path.dismiss")
        "snackbar" ->
          field(node, "text", path, PrototypeBindableKind.TEXT)
            ?: part(node["action"], "$path.action")
        else -> null
      }

    fun keys(node: JsonObject, path: String): T? {
      for (key in listOf("stateKey", "hourKey", "minuteKey")) {
        field(node, key, path, PrototypeBindableKind.KEY)?.let {
          return it
        }
      }
      (node["trailing"] as? JsonObject)?.let { trailing ->
        field(trailing, "stateKey", "$path.trailing", PrototypeBindableKind.KEY)?.let {
          return it
        }
      }
      return (node["openWhen"] as? JsonObject)?.let { openWhen ->
        field(openWhen, "key", "$path.openWhen", PrototypeBindableKind.KEY)
      }
    }

    fun node(node: JsonObject, path: String): T? {
      if ((node["type"] as? JsonPrimitive)?.content == "text") {
        field(node, "text", path, PrototypeBindableKind.TEXT)?.let {
          return it
        }
      }
      return component(node, path)
        ?: condition(node["visibleWhen"], "$path.visibleWhen")
        ?: objects(node, "styleWhen", path).firstNotNullOfOrNull { (entry, entryPath) ->
          condition(entry["when"], "$entryPath.when")
        }
        ?: actions(node, path)
        ?: keys(node, path)
    }
  }
}

/**
 * Static checks for `repeat` on an already structurally valid spec, mirroring the TypeScript
 * validator: placeholders name a field every item has, state keys bind to a literal key for every
 * item, a template holds no nested `repeat` or pager, and the expanded tree still fits the node and
 * image limits. Depth is unchanged because instances are siblings.
 */
internal object PrototypeRepeatValidator {
  /** A repeat container's path, its alias and its items. */
  data class Scope(val path: String, val alias: String, val items: List<JsonObject>)

  private data class Child(val node: JsonObject, val path: String)

  private class Budget(var nodes: Int = 0, var images: Int = 0)

  private val stateKeyPattern = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")

  fun validate(spec: JsonElement): PrototypeSpecError? {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return null
    return templateErrors(root, "root", null) ?: expandedErrors(root, "root", Budget(), null)
  }

  private fun fail(path: String, message: String) = PrototypeSpecError(path, message)

  private fun JsonObject.text(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun JsonElement?.string(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun hasPlaceholder(text: String, alias: String): Boolean =
    PrototypeRepeatTemplate.segments(text, alias).any { it !is PrototypeRepeatSegment.Literal }

  private fun unknownField(text: String, path: String, scope: Scope): PrototypeSpecError? {
    for (name in PrototypeRepeatTemplate.fieldReferences(text, scope.alias)) {
      if (!scope.items.all { it.containsKey(name) }) {
        return fail(path, "Unknown repeat field ${JsonPrimitive(name)}")
      }
    }
    return null
  }

  /** An emit name must stay non-empty for every item once its placeholders are bound. */
  private fun emptyEmitName(text: String, path: String, scope: Scope): PrototypeSpecError? {
    val empty =
      scope.items.withIndex().indexOfFirst { (index, item) ->
        PrototypeRepeatTemplate.bind(text, scope.alias, item, index).isEmpty()
      }
    return if (empty < 0) null else fail(path, "Expanded emit name is empty for item $empty")
  }

  /** A state key must bind to a literal key for every item; the failing item is reported. */
  private fun invalidBoundKey(key: String, path: String, scope: Scope): PrototypeSpecError? {
    if (!hasPlaceholder(key, scope.alias)) {
      return if (stateKeyPattern.matches(key)) null else fail(path, "Invalid key value")
    }
    for ((index, item) in scope.items.withIndex()) {
      val bound = PrototypeRepeatTemplate.bind(key, scope.alias, item, index)
      if (!stateKeyPattern.matches(bound)) {
        return fail(
          "${scope.path}.repeat.items[$index]",
          "Bound state key ${JsonPrimitive(bound)} is invalid",
        )
      }
    }
    return null
  }

  private fun fieldError(
    value: JsonElement?,
    path: String,
    kind: PrototypeBindableKind,
    scope: Scope,
  ): PrototypeSpecError? {
    val text = value.string() ?: return null
    unknownField(text, path, scope)?.let {
      return it
    }
    return when (kind) {
      PrototypeBindableKind.EMIT_NAME -> emptyEmitName(text, path, scope)
      PrototypeBindableKind.KEY -> invalidBoundKey(text, path, scope)
      else -> null
    }
  }

  private fun checkOwnFields(node: JsonObject, path: String, scope: Scope): PrototypeSpecError? =
    PrototypeBindableFields.first(node, path) { value, fieldPath, kind ->
      fieldError(value, fieldPath, kind, scope)
    }

  /** Outside every template a state key is literal, so a placeholder there is an invalid key. */
  private fun checkLiteralKeys(node: JsonObject, path: String): PrototypeSpecError? =
    PrototypeBindableFields.first(node, path) { value, fieldPath, kind ->
      val text = value.string()
      if (kind == PrototypeBindableKind.KEY && text != null && !stateKeyPattern.matches(text))
        fail(fieldPath, "State key placeholder outside a repeat template")
      else null
    }

  private fun childrenOf(node: JsonObject, path: String): List<Child> {
    (node["child"] as? JsonObject)?.let {
      return listOf(Child(it, "$path.child"))
    }
    return (node["children"] as? JsonArray).orEmpty().mapIndexedNotNull { index, entry ->
      (entry as? JsonObject)?.let { Child(it, "$path.children[$index]") }
    }
  }

  private fun scopeOf(node: JsonObject, path: String): Scope? {
    val repeat = node["repeat"] as? JsonObject ?: return null
    val alias = repeat.text("as") ?: return null
    val items = (repeat["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    return Scope(path, alias, items)
  }

  private fun templateErrors(node: JsonObject, path: String, scope: Scope?): PrototypeSpecError? {
    if (scope != null) {
      if (node.containsKey("repeat")) return fail("$path.repeat", "Nested repeat is not supported")
      if (node.text("type") == "pager")
        return fail(path, "Pager cannot appear inside a repeat template")
    }
    val own = if (scope != null) checkOwnFields(node, path, scope) else checkLiteralKeys(node, path)
    if (own != null) return own
    val childScope = scopeOf(node, path) ?: scope
    for (child in childrenOf(node, path)) {
      templateErrors(child.node, child.path, childScope)?.let {
        return it
      }
    }
    return null
  }

  private fun imageUses(node: JsonObject): Int =
    if (node.text("type") == "image") maxOf(1, prototypeImageSlotUses(node["asset"]))
    else
      (node["items"] as? JsonArray).orEmpty().sumOf {
        prototypeImageSlotUses((it as? JsonObject)?.get("image"))
      }

  /** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
  private fun expandedErrors(
    node: JsonObject,
    path: String,
    budget: Budget,
    repeatPath: String?,
  ): PrototypeSpecError? {
    val at = repeatPath ?: path
    if (++budget.nodes > PrototypeSpecValidator.MAX_PROTOTYPE_NODES)
      return fail(at, "Expanded node limit exceeded")
    budget.images += imageUses(node)
    if (budget.images > PrototypeSpecValidator.MAX_PROTOTYPE_IMAGES)
      return fail(at, "Expanded image limit exceeded")
    val scope = scopeOf(node, path)
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

  /** Every repeat container in the spec, outermost first. */
  fun scopes(spec: JsonElement): List<Scope> {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return emptyList()
    val scopes = mutableListOf<Scope>()
    fun collect(node: JsonObject, path: String) {
      scopeOf(node, path)?.let(scopes::add)
      for (child in childrenOf(node, path)) collect(child.node, child.path)
    }
    collect(root, "root")
    return scopes
  }

  private val checkedKeyFields = listOf("key", "stateKey", "hourKey", "minuteKey")

  /** The state-key values the validator type-checks: node keys and an action's `key`. */
  private fun checkedKeys(value: JsonObject): List<String> =
    checkedKeyFields.mapNotNull { value.text(it) } +
      listOfNotNull(
        (value["trailing"] as? JsonObject)?.text("stateKey"),
        (value["openWhen"] as? JsonObject)?.text("key"),
      )

  private fun bindKeys(value: JsonObject, scope: Scope, item: JsonObject, index: Int): JsonObject {
    fun JsonObject.bound(field: String): JsonObject {
      val text = text(field) ?: return this
      return JsonObject(
        this +
          (field to JsonPrimitive(PrototypeRepeatTemplate.bind(text, scope.alias, item, index))),
      )
    }
    var bound = value
    for (field in checkedKeyFields) bound = bound.bound(field)
    (bound["trailing"] as? JsonObject)?.let {
      bound = JsonObject(bound + ("trailing" to it.bound("stateKey")))
    }
    (bound["openWhen"] as? JsonObject)?.let {
      bound = JsonObject(bound + ("openWhen" to it.bound("key")))
    }
    return bound
  }

  /**
   * The per-item views the state-type checks run over: a node or action inside a template whose
   * state keys hold placeholders appears once per item with those keys bound; everything else
   * appears once, unchanged. Call only after [validate] passed.
   */
  fun keyInstances(
    scopes: List<Scope>,
    value: JsonObject,
    path: String,
  ): List<Pair<JsonObject, Int?>> {
    val scope = scopes.firstOrNull { path.startsWith("${it.path}.children[") }
    if (scope == null || checkedKeys(value).none { hasPlaceholder(it, scope.alias) }) {
      return listOf(value to null)
    }
    return scope.items.mapIndexed { index, item -> bindKeys(value, scope, item, index) to index }
  }
}
