package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.hasPlaceholder
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatKeyBindings.bindKeys
import dev.jasonpearson.automobile.protocol.PrototypeRepeatKeyBindings.checkedKeys
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.RepeatState
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTokens.isKeyCharacter
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTokens.isPlaceholder
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTokens.token
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTree.Budget
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTree.childrenOf
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTree.expandedErrors
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTree.scopeOf
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTree.templateErrors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

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
    PrototypeRepeatTokens.bind(segments(text, alias), alias, item, index)

  /**
   * CtrlProxy's repeat expander uses this typed binding operation; payload is never interpolated.
   */
  fun bindEmitContext(
    context: Map<String, EmitContextBinding>,
    alias: String,
    item: Map<String, JsonElement>,
    index: Int,
  ): Map<String, EmitContextBinding> = context.mapValues { (_, binding) ->
    bindBinding(binding, alias, item, index)
  }

  /** One emit-context style binding bound to a repeat row; also the value of a data action. */
  fun bindBinding(
    binding: EmitContextBinding,
    alias: String,
    item: Map<String, JsonElement>,
    index: Int,
  ): EmitContextBinding =
    when {
      "item" in binding ->
        JsonObject(
          mapOf("value" to (item[binding.getValue("item").jsonPrimitive.content] ?: JsonNull)),
        )
      "index" in binding -> JsonObject(mapOf("value" to JsonPrimitive(index)))
      "state" in binding ->
        JsonObject(
          binding +
            ("state" to
              JsonPrimitive(
                bind(binding.getValue("state").jsonPrimitive.content, alias, item, index),
              )),
        )
      else -> binding
    }

  /** A data action path with each whole `{index}` segment bound to the row. */
  fun bindDataPath(path: String, index: Int): String =
    path.split('/').joinToString("/") { if (it == INDEX_SEGMENT) index.toString() else it }

  /** True when the path holds a `{index}` placeholder anywhere in it. */
  fun dataPathHasIndex(path: String): Boolean =
    segments(path, NO_ALIAS).any { it is PrototypeRepeatSegment.Index }

  /**
   * The message for a data path whose placeholders break the grammar inside a repeat aliased
   * [alias], or null. Only a whole `{index}` segment binds; `{alias.field}` would let item content
   * inject pointer syntax.
   */
  fun dataPathPlaceholderMessage(path: String, alias: String): String? =
    when {
      segments(path, alias).any { it is PrototypeRepeatSegment.Field } ->
        "Only a whole {index} segment may be a placeholder in a data path"
      path.split('/').any { INDEX_SEGMENT in it && it != INDEX_SEGMENT } ->
        "{index} must be a whole data path segment"
      else -> null
    }

  private const val INDEX_SEGMENT = "{index}"

  // NUL cannot occur in a repeat alias, so only `{index}` is recognised as a placeholder.
  private const val NO_ALIAS = "\u0000"

  /** Integral numbers render without a decimal point or exponent at any magnitude. */
  fun rendered(value: JsonPrimitive): String {
    if (value.isString) return value.content
    val number = value.doubleOrNull
    return if (number != null && number.isFinite() && number == Math.floor(number))
      java.math.BigDecimal(number).toPlainString()
    else value.content
  }

  fun isFieldName(name: String): Boolean =
    name.length in 1..64 &&
      (name[0] in 'A'..'Z' || name[0] in 'a'..'z' || name[0] == '_') &&
      name.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' }
}

/** How a bindable field binds; mirrors `FieldKind` in the TypeScript `prototypeTemplate.ts`. */
internal enum class PrototypeBindableKind {
  TEXT,
  OPERAND,
  DATA_OPERAND,
  EMIT_NAME,
  EMIT_BINDING,
  KEY,

  /** A data action's `/data/...` path: renders to text, and only a whole `{index}` binds. */
  DATA_PATH,

  /**
   * A `request`'s `into`: the [DATA_PATH] grammar, kept apart as in TypeScript's `requestInto` so
   * data-action gating does not claim it.
   */
  REQUEST_INTO,

  /**
   * A `request` `url` or literal header/query string. It binds like [TEXT] (repeat placeholders,
   * limits) but `{data:/pointer}` and `{key}` are read when the request runs, so the render-time
   * data resolver leaves it alone.
   */
  REQUEST_TEXT;

  /** The kinds holding a `/data/...` path with `{index}` segments. */
  fun isDataPath(): Boolean = this == DATA_PATH || this == REQUEST_INTO
}

/**
 * Visits a node's own bindable fields (not its children) in the same order as the TypeScript
 * `mapBindableFields`: `text`, component fields, `visibleWhen`, `styleWhen`, `onTap`, then the
 * state-key fields. Stops at the first non-null result of [visit].
 */
internal object PrototypeBindableFields {
  private val contextNamePattern = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
  private val followUpLists = listOf("onSuccess", "onError")

  /** A member path as the TypeScript validator spells it: `.name`, or `["name"]` if not a name. */
  fun memberPath(path: String, name: String): String =
    if (contextNamePattern.matches(name)) "$path.$name"
    else "$path[" + JsonPrimitive(name).toString() + "]"

  fun <T : Any> first(
    node: JsonObject,
    path: String,
    visit: (JsonElement?, String, PrototypeBindableKind) -> T?,
  ): T? {
    val visitor = Visitor(visit)
    return visitor.node(node, path)
  }

  private fun objects(data: JsonObject, key: String, path: String): List<Pair<JsonObject, String>> =
    (data[key] as? JsonArray).orEmpty().mapIndexedNotNull { index, entry ->
      (entry as? JsonObject)?.let { it to "$path.$key[$index]" }
    }

  /** The first hit inside the action lists [names] of [action]: follow-ups, timer actions. */
  private fun <T : Any> Visitor<T>.actionLists(
    action: JsonObject,
    names: List<String>,
    path: String,
  ): T? {
    for (name in names) {
      for ((entry, entryPath) in objects(action, name, path)) {
        action(entry, entryPath)?.let {
          return it
        }
      }
    }
    return null
  }

  private class Visitor<T : Any>(
    val visit: (JsonElement?, String, PrototypeBindableKind) -> T?,
  ) {
    fun field(data: JsonObject, key: String, path: String, kind: PrototypeBindableKind): T? =
      data[key]?.let { visit(it, "$path.$key", kind) }

    fun keyList(data: JsonObject, key: String, path: String): T? {
      val values = data[key]
      return if (values is JsonArray)
        values.withIndex().firstNotNullOfOrNull { (index, value) ->
          visit(value, "$path.$key[$index]", PrototypeBindableKind.KEY)
        }
      else field(data, key, path, PrototypeBindableKind.KEY)
    }

    fun condition(value: JsonElement?, path: String): T? {
      val condition = value as? JsonObject ?: return null
      field(condition, "key", path, PrototypeBindableKind.KEY)?.let {
        return it
      }
      keyList(condition, "valid", path)?.let {
        return it
      }
      val operandKind =
        if (condition.containsKey("data")) PrototypeBindableKind.DATA_OPERAND
        else PrototypeBindableKind.OPERAND
      field(condition, "equals", path, operandKind)?.let {
        return it
      }
      field(condition, "notEquals", path, operandKind)?.let {
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
        "emit" ->
          field(action, "name", path, PrototypeBindableKind.EMIT_NAME)
            ?: emitContext(action, path)
            ?: keyList(action, "requireValid", path)
        "toggle",
        "increment",
        "decrement" -> field(action, "key", path, PrototypeBindableKind.KEY)
        "setData",
        "appendData" ->
          field(action, "path", path, PrototypeBindableKind.DATA_PATH)
            ?: binding(action["value"], "$path.value")
        "removeData" -> field(action, "path", path, PrototypeBindableKind.DATA_PATH)
        "startTimer" -> actionLists(action, listOf("actions"), path)
        "request" -> request(action, path)
        "platform" -> platform(action, path)
        else -> null
      }

    /** Mirrors `mapPlatformAction` (#14294): argument bindings, into, statusKey, follow-ups. */
    fun platform(action: JsonObject, path: String): T? {
      for ((name, value) in (action["args"] as? JsonObject).orEmpty()) {
        binding(value, memberPath("$path.args", name))?.let {
          return it
        }
      }
      field(action, "into", path, PrototypeBindableKind.REQUEST_INTO)?.let {
        return it
      }
      field(action, "statusKey", path, PrototypeBindableKind.KEY)?.let {
        return it
      }
      return actionLists(action, followUpLists, path)
    }

    /** Mirrors `mapRequestAction`: url, headers, query, body, into, statusKey, then follow-ups. */
    fun request(action: JsonObject, path: String): T? {
      field(action, "url", path, PrototypeBindableKind.REQUEST_TEXT)?.let {
        return it
      }
      for (name in listOf("headers", "query")) {
        entries(action, name, path)?.let {
          return it
        }
      }
      binding(action["body"], "$path.body")?.let {
        return it
      }
      field(action, "into", path, PrototypeBindableKind.REQUEST_INTO)?.let {
        return it
      }
      field(action, "statusKey", path, PrototypeBindableKind.KEY)?.let {
        return it
      }
      return actionLists(action, followUpLists, path)
    }

    /** A header or query entry: a literal string is text, an object is a value binding. */
    fun entries(action: JsonObject, name: String, path: String): T? {
      val entries = action[name] as? JsonObject ?: return null
      for ((key, value) in entries) {
        val at = memberPath("$path.$name", key)
        if (value is JsonObject)
          binding(value, at)?.let {
            return it
          }
        else
          visit(value, at, PrototypeBindableKind.REQUEST_TEXT)?.let {
            return it
          }
      }
      return null
    }

    /** An emit-binding value: the binding itself, then the state key it names. */
    fun binding(value: JsonElement?, at: String): T? {
      value ?: return null
      visit(value, at, PrototypeBindableKind.EMIT_BINDING)?.let {
        return it
      }
      return (value as? JsonObject)?.let { field(it, "state", at, PrototypeBindableKind.KEY) }
    }

    fun emitContext(action: JsonObject, path: String): T? {
      val context = action["context"] as? JsonObject ?: return null
      for ((name, value) in context) {
        val at = memberPath("$path.context", name)
        binding(value, at)?.let {
          return it
        }
      }
      return null
    }

    fun actions(data: JsonObject, path: String): T? {
      for (field in listOf("onTap", "onLongPress", "onDoubleTap", "onAppear")) {
        for ((action, actionPath) in objects(data, field, path)) {
          action(action, actionPath)?.let {
            return it
          }
        }
      }
      return null
    }

    fun node(node: JsonObject, path: String): T? = Components(this).node(node, path)
  }

  private class Components<T : Any>(val visitor: Visitor<T>) {
    /** Swipe action labels and actions on a row or listItem bind like any other part. */
    fun swipeParts(node: JsonObject, path: String): T? {
      val swipe = node["swipeActions"] as? JsonObject ?: return null
      for (side in listOf("start", "end")) {
        for ((entry, entryPath) in objects(swipe, side, "$path.swipeActions")) {
          part(entry, entryPath)?.let {
            return it
          }
        }
      }
      return null
    }

    /** A `{label, onTap?}` part (dialog or snackbar button, app bar action). */
    fun part(value: JsonElement?, path: String): T? {
      val part = value as? JsonObject ?: return null
      return visitor.field(part, "label", path, PrototypeBindableKind.TEXT)
        ?: visitor.actions(part, path)
    }

    fun component(node: JsonObject, path: String): T? =
      when ((node["type"] as? JsonPrimitive)?.content) {
        "button",
        "fab" -> visitor.field(node, "label", path, PrototypeBindableKind.TEXT)
        "menu" ->
          objects(node, "items", path).firstNotNullOfOrNull { (entry, entryPath) ->
            part(entry, entryPath)
              ?: visitor.field(entry, "trailingText", entryPath, PrototypeBindableKind.TEXT)
          }
        "select" ->
          visitor.field(node, "label", path, PrototypeBindableKind.TEXT)
            ?: objects(node, "options", path).firstNotNullOfOrNull { (option, optionPath) ->
              visitor.field(option, "label", optionPath, PrototypeBindableKind.TEXT)
            }
        "segmentedButton" ->
          objects(node, "options", path).firstNotNullOfOrNull { (option, optionPath) ->
            visitor.field(option, "label", optionPath, PrototypeBindableKind.TEXT)
          }
        "topAppBar" ->
          visitor.field(node, "title", path, PrototypeBindableKind.TEXT)
            ?: part(node["navigationIcon"], "$path.navigationIcon")
            ?: objects(node, "actions", path).firstNotNullOfOrNull { (entry, entryPath) ->
              part(entry, entryPath)
            }
        "textField",
        "searchBar",
        "dialog",
        "snackbar" -> formComponent(node, path)
        else -> null
      }

    private fun formComponent(node: JsonObject, path: String): T? =
      when ((node["type"] as? JsonPrimitive)?.content) {
        "textField" ->
          part(node["trailingIcon"], "$path.trailingIcon")
            ?: objects(node, "onSubmit", path).firstNotNullOfOrNull { (entry, entryPath) ->
              visitor.action(entry, entryPath)
            }
        "searchBar" ->
          visitor.field(node, "placeholder", path, PrototypeBindableKind.TEXT)
            ?: objects(node, "trailingActions", path).firstNotNullOfOrNull { (entry, entryPath) ->
              part(entry, entryPath)
            }
            ?: objects(node, "onSubmit", path).firstNotNullOfOrNull { (entry, entryPath) ->
              visitor.action(entry, entryPath)
            }
        "dialog" ->
          visitor.field(node, "title", path, PrototypeBindableKind.TEXT)
            ?: visitor.field(node, "text", path, PrototypeBindableKind.TEXT)
            ?: part(node["confirm"], "$path.confirm")
            ?: part(node["dismiss"], "$path.dismiss")
        "snackbar" ->
          visitor.field(node, "text", path, PrototypeBindableKind.TEXT)
            ?: part(node["action"], "$path.action")
        else -> null
      }

    fun keys(node: JsonObject, path: String): T? {
      for (key in listOf("stateKey", "activeKey", "hourKey", "minuteKey", "atEndKey")) {
        visitor.field(node, key, path, PrototypeBindableKind.KEY)?.let {
          return it
        }
      }
      (node["trailing"] as? JsonObject)?.let { trailing ->
        visitor.field(trailing, "stateKey", "$path.trailing", PrototypeBindableKind.KEY)?.let {
          return it
        }
      }
      (node["refresh"] as? JsonObject)?.let { refresh ->
        visitor.field(refresh, "stateKey", "$path.refresh", PrototypeBindableKind.KEY)?.let {
          return it
        }
      }
      return (node["openWhen"] as? JsonObject)?.let { openWhen ->
        visitor.field(openWhen, "key", "$path.openWhen", PrototypeBindableKind.KEY)
      }
    }

    /** Pull-to-refresh actions on a scroll: they bind like `onTap`. */
    fun refreshActions(node: JsonObject, path: String): T? {
      val refresh = node["refresh"] as? JsonObject ?: return null
      for ((action, actionPath) in objects(refresh, "onRefresh", "$path.refresh")) {
        visitor.action(action, actionPath)?.let {
          return it
        }
      }
      return null
    }

    fun node(node: JsonObject, path: String): T? {
      if ((node["type"] as? JsonPrimitive)?.content == "text") {
        visitor.field(node, "text", path, PrototypeBindableKind.TEXT)?.let {
          return it
        }
        for ((span, spanPath) in objects(node, "spans", path)) {
          (visitor.field(span, "text", spanPath, PrototypeBindableKind.TEXT)
              ?: visitor.actions(span, spanPath))
            ?.let {
              return it
            }
        }
      }
      return component(node, path)
        ?: visitor.condition(node["enabledWhen"], "$path.enabledWhen")
        // Bind only the message as text; pattern source and other check operands stay literal.
        ?: objects(node, "checks", path).firstNotNullOfOrNull { (entry, entryPath) ->
          visitor.field(entry, "message", entryPath, PrototypeBindableKind.TEXT)
        }
        ?: visitor.condition(node["visibleWhen"], "$path.visibleWhen")
        ?: objects(node, "styleWhen", path).firstNotNullOfOrNull { (entry, entryPath) ->
          visitor.condition(entry["when"], "$entryPath.when")
        }
        ?: visitor.actions(node, path)
        ?: refreshActions(node, path)
        ?: swipeParts(node, path)
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
  data class Scope(
    val path: String,
    val alias: String,
    val items: List<JsonObject>,
    val pathBound: Boolean = false,
  )

  fun validate(
    spec: JsonElement,
    data: PrototypeRepeatData =
      PrototypeRepeatData((spec as? JsonObject)?.get("data") as? JsonObject),
  ): PrototypeSpecError? {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return null
    return templateErrors(root, "root", null, RepeatState(data))
      ?: expandedErrors(root, "root", Budget(), null, data)
  }

  /** Every repeat container in the spec, outermost first. */
  fun scopes(
    spec: JsonElement,
    data: PrototypeRepeatData =
      PrototypeRepeatData((spec as? JsonObject)?.get("data") as? JsonObject),
  ): List<Scope> {
    val root = (spec as? JsonObject)?.get("root") as? JsonObject ?: return emptyList()
    val scopes = mutableListOf<Scope>()
    fun collect(node: JsonObject, path: String) {
      scopeOf(node, path, data)?.let(scopes::add)
      for (child in childrenOf(node, path)) collect(child.node, child.path)
    }
    collect(root, "root")
    return scopes
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

  /**
   * True when the entry's `value` operand holds a repeat placeholder, so its type is not static.
   */
  fun operandTemplated(scopes: List<Scope>, value: JsonObject, path: String): Boolean {
    val scope = scopes.firstOrNull { path.startsWith("${it.path}.children[") } ?: return false
    return value.text("value")?.let { hasPlaceholder(it, scope.alias) } == true
  }
}
