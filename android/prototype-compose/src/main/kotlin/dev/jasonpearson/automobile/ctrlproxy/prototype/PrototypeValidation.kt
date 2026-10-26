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
  formatter: PrototypeValueFormatter = AndroidPrototypeValueFormatter(),
): List<PrototypeNode> = buildList {
  fun visit(node: PrototypeNode, path: String) {
    if (node.checks().isNotEmpty()) add(node)
    prototypeChildEntries(node, path, formatter = formatter).forEach { visit(it.node, it.path) }
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
): String? =
  node.checkedKeys().firstNotNullOfOrNull { key ->
    if (key !in shown) null
    else
      PrototypeChecks.evaluate(state[key], node.checks(), prototypeNodeRole(node))
        .firstFailingMessage
  }

/** State changes do not alter repeat projections; relative values refresh with their source. */
internal class PrototypeCheckedNodeCache(private val formatter: PrototypeValueFormatter) {
  private var root: PrototypeNode? = null
  private var data: JsonObject? = null
  private var locale: Locale? = null
  private var zone: String? = null
  private var nodes: List<PrototypeNode> = emptyList()

  fun nodes(spec: PrototypeSpec): List<PrototypeNode> {
    val currentLocale = Locale.getDefault()
    val currentZone = TimeZone.getDefault().id
    val environmentChanged = locale != currentLocale || zone != currentZone
    if (root !== spec.root || data !== spec.data || environmentChanged) {
      val resolved = PrototypeDataResolver.resolve(spec)
      val checked = checkedPrototypeNodes(resolved.root, formatter)
      root = spec.root
      data = spec.data
      locale = currentLocale
      zone = currentZone
      nodes = checked
    }
    return nodes
  }
}
