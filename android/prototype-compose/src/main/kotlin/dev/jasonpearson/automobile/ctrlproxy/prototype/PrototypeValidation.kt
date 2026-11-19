package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCheck
import dev.jasonpearson.automobile.protocol.PrototypeCheckboxNode
import dev.jasonpearson.automobile.protocol.PrototypeChecks
import dev.jasonpearson.automobile.protocol.PrototypeChipNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeDataResolver
import dev.jasonpearson.automobile.protocol.PrototypeDatePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeFabNode
import dev.jasonpearson.automobile.protocol.PrototypeIconButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeListItemNode
import dev.jasonpearson.automobile.protocol.PrototypeListNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeRadioGroupNode
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSliderNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSwitchNode
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeValidateOn
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.JsonObject

internal fun PrototypeNode.checks(): List<PrototypeCheck> =
  when (this) {
    is PrototypeTextFieldNode -> checks.orEmpty()
    is PrototypeSliderNode -> checks.orEmpty()
    is PrototypeCheckboxNode -> checks.orEmpty()
    is PrototypeSwitchNode -> checks.orEmpty()
    is PrototypeRadioGroupNode -> checks.orEmpty()
    is PrototypeDatePickerNode -> checks.orEmpty()
    is PrototypeTimePickerNode -> checks.orEmpty()
    else -> emptyList()
  }

internal fun PrototypeNode.validationMode(): PrototypeValidateOn =
  when (this) {
    is PrototypeTextFieldNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeSliderNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeCheckboxNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeSwitchNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeRadioGroupNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeDatePickerNode -> validateOn ?: PrototypeValidateOn.BLUR
    is PrototypeTimePickerNode -> validateOn ?: PrototypeValidateOn.BLUR
    else -> PrototypeValidateOn.BLUR
  }

internal fun PrototypeNode.enabledCondition(): PrototypeCondition? =
  when (this) {
    is PrototypeTextFieldNode -> enabledWhen
    is PrototypeSliderNode -> enabledWhen
    is PrototypeCheckboxNode -> enabledWhen
    is PrototypeSwitchNode -> enabledWhen
    is PrototypeRadioGroupNode -> enabledWhen
    is PrototypeDatePickerNode -> enabledWhen
    is PrototypeTimePickerNode -> enabledWhen
    is PrototypeButtonNode -> enabledWhen
    is PrototypeIconButtonNode -> enabledWhen
    is PrototypeFabNode -> enabledWhen
    is PrototypeChipNode -> enabledWhen
    is PrototypeListItemNode -> enabledWhen
    else -> null
  }

internal fun PrototypeNode.checkedKeys(): List<String> =
  when (this) {
    is PrototypeTextFieldNode -> listOf(stateKey)
    is PrototypeSliderNode -> listOf(stateKey)
    is PrototypeCheckboxNode -> listOf(stateKey)
    is PrototypeSwitchNode -> listOf(stateKey)
    is PrototypeRadioGroupNode -> listOf(stateKey)
    is PrototypeDatePickerNode -> listOf(stateKey)
    is PrototypeTimePickerNode -> listOf(hourKey, minuteKey)
    else -> emptyList()
  }

/** Includes bound repeat instances and data-resolved nodes, in authored order. */
internal fun checkedPrototypeNodes(
  root: PrototypeNode,
  data: kotlinx.serialization.json.JsonObject? = null,
  formatter: PrototypeValueFormatter = AndroidPrototypeValueFormatter(),
  derived: Map<String, kotlinx.serialization.json.JsonElement?> = emptyMap(),
): List<PrototypeNode> = buildList {
  fun visit(node: PrototypeNode, path: String) {
    if (node.checks().isNotEmpty()) add(node)
    if (node is PrototypeListNode) {
      node.header?.let { visit(it, "$path.header") }
      if (node.children.any(::hasPrototypeChecks)) {
        prototypeDerivedListRows(node, data, derived).forEachIndexed { index, item ->
          visit(bindPrototypeListRow(node, item, index), "$path.repeat[$index].children[0]")
        }
      }
      node.footer?.let { visit(it, "$path.footer") }
    } else
      prototypeChildEntries(prototypeDerivedRepeatNode(node, derived), path, formatter = formatter)
        .forEach { visit(it.node, it.path) }
  }
  visit(root, "root")
}

internal fun prototypeValidity(
  nodes: List<PrototypeNode>,
  state: Map<String, PrototypeScalar>,
): Map<String, Boolean> = buildMap {
  for (node in nodes) {
    for (key in node.checkedKeys()) {
      val valid = PrototypeChecks.evaluate(state[key], node.checks(), prototypeNodeRole(node)).valid
      put(key, (get(key) ?: true) && valid)
    }
  }
}

internal fun prototypeShownError(
  node: PrototypeNode,
  state: Map<String, PrototypeScalar>,
  shown: Set<String>,
  validity: Map<String, Boolean> = emptyMap(),
): String? {
  val checkMessage =
    node.checkedKeys().firstNotNullOfOrNull { key ->
      if (key !in shown) null
      else
        PrototypeChecks.evaluate(state[key], node.checks(), prototypeNodeRole(node))
          .firstFailingMessage
    }
  return if (node is PrototypeTextFieldNode && node.errorWhen?.holds(state, validity) == true)
    node.errorText ?: checkMessage ?: node.supportingText
  else checkMessage
}

internal fun prototypeIsError(
  node: PrototypeNode,
  state: Map<String, PrototypeScalar>,
  shown: Set<String>,
  validity: Map<String, Boolean> = emptyMap(),
): Boolean =
  (node is PrototypeTextFieldNode && node.errorWhen?.holds(state, validity) == true) ||
    prototypeShownError(node, state, shown, validity) != null

/** Skip binding rows entirely for the usual display-only list. */
private fun hasPrototypeChecks(node: PrototypeNode): Boolean =
  node.checks().isNotEmpty() || prototypeDescendants(node).any(::hasPrototypeChecks)

/** Checked rows refresh with their source, collection membership or formatting environment. */
internal class PrototypeCheckedNodeCache(private val formatter: PrototypeValueFormatter) {
  private var root: PrototypeNode? = null
  private var data: JsonObject? = null
  private var locale: Locale? = null
  private var zone: String? = null
  private var nodes: List<PrototypeNode> = emptyList()
  private val derivedCache = PrototypeDerivedValuesCache()
  private var derivedValues: Map<String, kotlinx.serialization.json.JsonElement?> = emptyMap()

  fun nodes(spec: PrototypeSpec): List<PrototypeNode> {
    if (!hasPrototypeChecks(spec.root)) return emptyList()
    val currentLocale = Locale.getDefault()
    val currentZone = TimeZone.getDefault().id
    val currentDerived = derivedCache.evaluate(spec)
    val collectionsChanged = currentDerived.any { (name, value) ->
      spec.derive?.get(name)?.collection != null &&
        spec.derive?.get(name)?.reduce == null &&
        derivedValues[name] !== value
    }
    val environmentChanged = locale != currentLocale || zone != currentZone
    val sourceChanged = root !== spec.root || data !== spec.data
    if (sourceChanged || environmentChanged || collectionsChanged) {
      val resolved = PrototypeDataResolver.resolve(spec)
      val checked = checkedPrototypeNodes(resolved.root, spec.data, formatter, currentDerived)
      root = spec.root
      data = spec.data
      locale = currentLocale
      zone = currentZone
      nodes = checked
      derivedValues = currentDerived
    }
    return nodes
  }
}
