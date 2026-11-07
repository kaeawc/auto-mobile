package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The runtime half of navigation routes (#14188, `prototype_routes_v1`), shared by every Android
 * host: resolving push/replace/setStack params, checking them against a screen's declared params,
 * binding `{route.<name>}` placeholders and the `stack:<id>` stored path. The contract half is
 * [PrototypeRouteRules]; the Swift twin lives in the iOS prototype agent.
 */
object PrototypeRouteRuntime {
  /** How deep onEnter/onBack lists may nest through the navigation they cause. */
  const val MAX_LIFECYCLE_DEPTH = 8

  const val STACK_STORAGE_PREFIX = "stack:"

  private val empty = JsonObject(emptyMap())
  private val defaultJson = Json { classDiscriminator = "type" }

  /**
   * [params] with each binding resolved against [inputs]: a literal scalar stays, `{value}`,
   * `{state}` and `{data}` read their source. Null when a binding cannot be resolved or a value is
   * not a JSON scalar.
   */
  fun resolve(params: Map<String, JsonElement>?, inputs: EmitContextInputs): JsonObject? {
    val resolved = LinkedHashMap<String, JsonElement>()
    for ((name, raw) in params.orEmpty()) {
      val value =
        if (raw is JsonObject)
          (PrototypeDataWriter.resolveValue(raw, inputs) as? PrototypeDataValue.Resolved)?.value
        else raw
      if (typeOf(value) == null) return null
      resolved[name] = checkNotNull(value)
    }
    return JsonObject(resolved)
  }

  /** The declared type name of a scalar param value, or null for anything else. */
  fun typeOf(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    return when {
      primitive is JsonNull -> null
      primitive.isString -> "string"
      primitive.booleanOrNull != null -> "boolean"
      primitive.doubleOrNull?.isFinite() == true -> "number"
      else -> null
    }
  }

  /** True when [params] holds exactly the params [node] declares for [screen], each well typed. */
  fun fits(node: PrototypeStackNode, screen: String, params: JsonObject): Boolean {
    if (screen !in node.screens) return false
    val declared = node.routes?.get(screen)?.params.orEmpty()
    return declared.keys == params.keys &&
      params.all { (name, value) -> typeOf(value) == declared[name] }
  }

  /** The route of [screen] in [node], if it declares one. */
  fun route(node: PrototypeStackNode, screen: String): PrototypeRoute? = node.routes?.get(screen)

  /** The `stack:<id>` storage key of a stack. */
  fun storageKey(stackId: String): String = STACK_STORAGE_PREFIX + stackId

  /** The value stored for [snapshot]: `[{screen, params?}]`, params left out when empty. */
  fun storedValue(snapshot: PrototypeStackSnapshot): JsonArray =
    JsonArray(
      snapshot.path.mapIndexed { index, screen ->
        val params = snapshot.paramsAt(index)
        JsonObject(
          buildMap {
            put("screen", JsonPrimitive(screen))
            if (params.isNotEmpty()) put("params", params)
          },
        )
      },
    )

  /**
   * The path a stored [value] restores for [node], or null when it no longer fits: not an array of
   * 1..MAX_PROTOTYPE_STACK_DEPTH `{screen, params?}` objects whose screens exist and whose params
   * match the declarations exactly.
   */
  fun restore(node: PrototypeStackNode, value: JsonElement?): PrototypeStackSnapshot? {
    val entries = value as? JsonArray ?: return null
    if (entries.size !in 1..PrototypeSpecValidator.MAX_PROTOTYPE_STACK_DEPTH) return null
    val screens = ArrayList<String>(entries.size)
    val params = ArrayList<JsonObject>(entries.size)
    for (entry in entries) {
      val fields = entry as? JsonObject ?: return null
      if (fields.keys.any { it != "screen" && it != "params" }) return null
      val screen =
        (fields["screen"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      val entryParams = (fields["params"] ?: empty) as? JsonObject ?: return null
      if (!fits(node, screen, entryParams)) return null
      screens += screen
      params += entryParams
    }
    return PrototypeStackSnapshot.of(screens, params)
  }

  /**
   * [root] with each stack's top screen bound to its top entry's params, nested stacks with their
   * own. The same instance comes back when no stack's top entry has params, which is the only case
   * where a `{route.<name>}` placeholder can be on screen.
   */
  fun bindRoot(
    root: PrototypeNode,
    stacks: Map<String, PrototypeStackSnapshot>,
    json: Json = defaultJson,
  ): PrototypeNode {
    if (stacks.values.none { it.paramsAt(it.path.lastIndex).isNotEmpty() }) return root
    val encoded = json.encodeToJsonElement(PrototypeNode.serializer(), root)
    return json.decodeFromJsonElement(
      PrototypeNode.serializer(),
      PrototypeRouteBinder.bind(encoded, empty, stacks),
    )
  }

  /** [actions] (a route's onEnter or onBack) with `{route.<name>}` bound to [params]. */
  fun bindActions(
    actions: List<PrototypeAction>,
    params: JsonObject,
    stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
    json: Json = defaultJson,
  ): List<PrototypeAction> {
    if (params.isEmpty()) return actions
    val serializer = ListSerializer(PrototypeAction.serializer())
    val encoded = json.encodeToJsonElement(serializer, actions)
    return json.decodeFromJsonElement(
      serializer,
      PrototypeRouteBinder.bind(encoded, params, stacks),
    )
  }
}

/** Binds `{route.<name>}` placeholders in encoded nodes and actions for [PrototypeRouteRuntime]. */
internal object PrototypeRouteBinder {
  private const val ALIAS = "route"
  private val empty = JsonObject(emptyMap())
  private val typedKeys = setOf("equals", "notEquals", "value")
  private val pointerKeys = setOf("data", "path", "into", "to")

  fun bind(
    element: JsonElement,
    params: JsonObject,
    stacks: Map<String, PrototypeStackSnapshot>,
    key: String? = null,
  ): JsonElement =
    when (element) {
      is JsonObject ->
        if ((element["type"] as? JsonPrimitive)?.content == "stack" && "screens" in element)
          bindStack(element, params, stacks)
        else
          JsonObject(
            element.mapValues { (name, value) ->
              // Each entry of a params map is an operand that keeps its type.
              bind(value, params, stacks, if (key == "params") "value" else name)
            },
          )
      is JsonArray -> JsonArray(element.map { bind(it, params, stacks, key) })
      is JsonPrimitive ->
        if (element.isString && params.isNotEmpty()) bindText(element.content, params, key)
        else element
    }

  /** A stack's own fields bind in the enclosing scope; its top screen in its own. */
  private fun bindStack(
    stack: JsonObject,
    params: JsonObject,
    stacks: Map<String, PrototypeStackSnapshot>,
  ): JsonObject {
    val id = (stack["id"] as? JsonPrimitive)?.content
    val snapshot = id?.let(stacks::get)
    val top = snapshot?.path?.lastOrNull() ?: (stack["start"] as? JsonPrimitive)?.content
    val topParams = snapshot?.paramsAt(snapshot.path.lastIndex) ?: empty
    return JsonObject(
      stack.mapValues { (name, value) ->
        when (name) {
          "screens" ->
            JsonObject(
              (value as JsonObject).mapValues { (screen, node) ->
                if (screen == top) bind(node, topParams, stacks) else node
              },
            )
          // Lifecycle lists bind when they run, with the entry that runs them.
          "routes" -> value
          else -> bind(value, params, stacks, name)
        }
      },
    )
  }

  private fun bindText(text: String, params: JsonObject, key: String?): JsonPrimitive {
    val segments = PrototypeRepeatTemplate.segments(text, ALIAS)
    if (segments.none { it is PrototypeRepeatSegment.Field }) return JsonPrimitive(text)
    val single = segments.singleOrNull() as? PrototypeRepeatSegment.Field
    if (key in typedKeys && single != null) {
      (params[single.name] as? JsonPrimitive)?.let {
        return it
      }
    }
    if (key in pointerKeys && text.startsWith("/"))
      return JsonPrimitive(text.split('/').joinToString("/") { pointerSegment(it, params) })
    return JsonPrimitive(render(segments, params))
  }

  /** A whole `{route.x}` pointer segment becomes the value, escaped per RFC 6901. */
  private fun pointerSegment(segment: String, params: JsonObject): String {
    val field =
      PrototypeRepeatTemplate.segments(segment, ALIAS).singleOrNull()
        as? PrototypeRepeatSegment.Field
    val value = field?.let { params[it.name] as? JsonPrimitive } ?: return segment
    return PrototypeRepeatTemplate.rendered(value).replace("~", "~0").replace("/", "~1")
  }

  /** `{index}` and unknown names stay literal: they belong to a repeat or are not params. */
  private fun render(segments: List<PrototypeRepeatSegment>, params: JsonObject): String =
    segments.joinToString("") { segment ->
      when (segment) {
        is PrototypeRepeatSegment.Literal -> segment.text
        PrototypeRepeatSegment.Index -> "{index}"
        is PrototypeRepeatSegment.Field ->
          (params[segment.name] as? JsonPrimitive)?.let(PrototypeRepeatTemplate::rendered)
            ?: "{$ALIAS.${segment.name}}"
      }
    }
}
