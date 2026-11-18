package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*

private val scalarJson = Json { ignoreUnknownKeys = false }

/** One mapper owns this snapshot; state edits invalidate only actual inputs. */
internal class PrototypeDerivedValuesCache(
  private val observer: PrototypeDeriveObserver? = null,
) {
  private var spec: PrototypeSpec? = null
  private var values: Map<String, JsonElement?> = emptyMap()

  fun evaluate(current: PrototypeSpec): Map<String, JsonElement?> {
    val old = spec
    val before = old?.state.orEmpty()
    val after = current.state.orEmpty()
    val changedKeys =
      (before.keys + after.keys).filterTo(mutableSetOf()) { before[it] != after[it] }
    val beforeData = old?.data.orEmpty()
    val afterData = current.data.orEmpty()
    val changedData =
      (beforeData.keys + afterData.keys)
        .filter { beforeData[it] !== afterData[it] }
        .mapTo(mutableSetOf()) { "/" + it.replace("~", "~0").replace("/", "~1") }
    values =
      PrototypeDerive.evaluate(
        current.derive,
        current.data,
        after.mapValues { EmitContextResolver.scalar(it.value) },
        values.takeIf { old?.derive == current.derive },
        PrototypeDeriveChanges(changedData, changedKeys),
        observer,
      )
    spec = current
    return values
  }
}

/** Reuses the existing keyed row binder; only scalar fields enter the repeat template scope. */
internal fun prototypeDerivedRepeatNode(
  node: PrototypeNode,
  values: Map<String, JsonElement?>,
): PrototypeNode {
  if (prototypeRepeatDerivedName(node) == null) return node
  return when (node) {
    is PrototypeBoxNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    is PrototypeRowNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    is PrototypeColumnNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    is PrototypeFlowNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    is PrototypeGridNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    is PrototypeCarouselNode -> node.copy(repeat = resolveDerivedRepeat(node, node.repeat, values))
    else -> node
  }
}

internal fun prototypeDerivedListRows(
  node: PrototypeListNode,
  data: JsonObject?,
  values: Map<String, JsonElement?>,
): List<JsonObject> {
  val name = node.repeat.itemsDerived ?: return PrototypeListRows.items(node, data)
  return prototypeCollectionRows(values[name])
}

private fun resolveDerivedRepeat(
  node: PrototypeNode,
  repeat: PrototypeRepeat?,
  values: Map<String, JsonElement?>,
): PrototypeRepeat? {
  val name = repeat?.itemsDerived ?: return repeat
  val rows =
    prototypeCollectionRows(values[name]).map { row ->
      row
        .filterValues { it is JsonPrimitive }
        .mapValues { (_, value) ->
          scalarJson.decodeFromJsonElement(PrototypeScalar.serializer(), value)
        }
    }
  val raw = prototypeCollectionRows(values[name])
  val error = PrototypeDerivedRows.validate(node, rows, raw)
  require(error == null) { "${error?.path}: ${error?.message}" }
  return repeat.copy(items = rows, itemsDerived = null, sourceItems = raw)
}

private fun prototypeCollectionRows(value: JsonElement?): List<JsonObject> {
  return (value as? JsonArray).orEmpty().filterIsInstance<JsonObject>().map { row ->
    JsonObject(
      row.filter { (key, value) ->
        PrototypeRepeatTemplate.isFieldName(key) &&
          (value is JsonArray ||
            (value is JsonPrimitive &&
              value != JsonNull &&
              (value.isString ||
                value.booleanOrNull != null ||
                value.doubleOrNull?.isFinite() == true)))
      },
    )
  }
}

/** Display projections refresh with their raw value or the device formatting environment. */
internal class PrototypeDerivedFormatterCache(private val delegate: PrototypeValueFormatter) :
  PrototypeValueFormatter {
  private data class Display(
    val input: JsonElement?,
    val locale: java.util.Locale,
    val zone: String,
    val text: String,
  )

  private val displays = mutableMapOf<PrototypeDerivedEntry, Display>()

  override fun format(entry: PrototypeDerivedEntry, input: JsonElement?): String {
    val locale = java.util.Locale.getDefault()
    val zone = java.util.TimeZone.getDefault().id
    val old = displays[entry]
    if (old != null) {
      val sameEnvironment = old.locale == locale && old.zone == zone
      if (old.input === input && sameEnvironment) return old.text
    }
    val text = delegate.format(entry, input)
    if (entry !in displays && displays.size >= 32) displays.clear()
    displays[entry] = Display(input, locale, zone, text)
    return text
  }
}
