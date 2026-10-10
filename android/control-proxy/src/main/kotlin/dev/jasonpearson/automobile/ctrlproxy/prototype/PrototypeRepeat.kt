package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeAppBarAction
import dev.jasonpearson.automobile.protocol.PrototypeBadgeNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomNavNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomSheetNode
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCardNode
import dev.jasonpearson.automobile.protocol.PrototypeCheckboxNode
import dev.jasonpearson.automobile.protocol.PrototypeChipNode
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeDatePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeDecrementAction
import dev.jasonpearson.automobile.protocol.PrototypeDialogButton
import dev.jasonpearson.automobile.protocol.PrototypeDialogNode
import dev.jasonpearson.automobile.protocol.PrototypeDividerNode
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeFabNode
import dev.jasonpearson.automobile.protocol.PrototypeIconButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeIconNode
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeIncrementAction
import dev.jasonpearson.automobile.protocol.PrototypeListItemCheckbox
import dev.jasonpearson.automobile.protocol.PrototypeListItemNode
import dev.jasonpearson.automobile.protocol.PrototypeListItemSwitch
import dev.jasonpearson.automobile.protocol.PrototypeListItemTrailing
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypePagerNode
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import dev.jasonpearson.automobile.protocol.PrototypeRadioGroupNode
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeRepeatSegment
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTemplate
import dev.jasonpearson.automobile.protocol.PrototypeRowNode
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeScrollNode
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeSliderNode
import dev.jasonpearson.automobile.protocol.PrototypeSnackbarNode
import dev.jasonpearson.automobile.protocol.PrototypeSpacerNode
import dev.jasonpearson.automobile.protocol.PrototypeStyleWhen
import dev.jasonpearson.automobile.protocol.PrototypeSwitchNode
import dev.jasonpearson.automobile.protocol.PrototypeTabBarNode
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction
import dev.jasonpearson.automobile.protocol.PrototypeTopAppBarNode

/** A child to render and the path it is rendered under (also its stable Compose identity). */
internal data class PrototypeChildEntry(val node: PrototypeNode, val path: String)

private data class RepeatInstance(
  val alias: String,
  val item: Map<String, PrototypeScalar>,
  val index: Int,
)

private fun PrototypeNode.repeatSpec(): PrototypeRepeat? =
  when (this) {
    is PrototypeBoxNode -> repeat
    is PrototypeRowNode -> repeat
    is PrototypeColumnNode -> repeat
    else -> null
  }

/**
 * The children [node] renders, with `repeat` expanded before layout: the template children are
 * instantiated once per item, in item order, each bound to its item and `{index}`. Instance
 * children live under `path.repeat[item].children[template]`, so a row keeps its identity (and its
 * Compose key) for as long as it keeps its index. Without a `repeat` this is the plain child list.
 * Pass [bind] false to walk the shape only (limit guards) without copying any node.
 */
internal fun prototypeChildEntries(
  node: PrototypeNode,
  path: String,
  bind: Boolean = true,
): List<PrototypeChildEntry> {
  val children = prototypeDescendants(node)
  val repeat = node.repeatSpec()
  if (repeat == null) {
    val single =
      node is PrototypeScrollNode || node is PrototypeBottomSheetNode || node is PrototypeDialogNode
    return children.mapIndexed { index, child ->
      PrototypeChildEntry(child, if (single) "$path.child" else "$path.children[$index]")
    }
  }
  return repeat.items.flatMapIndexed { itemIndex, item ->
    val instance = RepeatInstance(repeat.`as`, item, itemIndex)
    children.mapIndexed { index, child ->
      PrototypeChildEntry(
        if (bind) child.bound(instance) else child,
        "$path.repeat[$itemIndex].children[$index]",
      )
    }
  }
}

private fun PrototypeNode.bound(instance: RepeatInstance): PrototypeNode {
  val onTap = onTap?.map { it.bound(instance) }
  val styleWhen = styleWhen?.map { PrototypeStyleWhen(it.`when`.bound(instance), it.style) }
  val visibleWhen = visibleWhen?.bound(instance)
  fun List<PrototypeNode>.bound() = map { it.bound(instance) }
  return when (this) {
    is PrototypeBoxNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeRowNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeColumnNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypePagerNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeCardNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeTextNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        text = instance.interpolate(text),
      )
    is PrototypeScrollNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        child = child.bound(instance),
      )
    is PrototypeBottomSheetNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        child = child.bound(instance),
      )
    is PrototypeImageNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeIconNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeSpacerNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeTextFieldNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeTabBarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeBottomNavNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeSwitchNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeCheckboxNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeButtonNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        label = instance.interpolate(label),
      )
    is PrototypeSliderNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeChipNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeRadioGroupNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeListItemNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        trailing = trailing?.bound(instance),
      )
    is PrototypeDialogNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        title = title?.let(instance::interpolate),
        text = text?.let(instance::interpolate),
        confirm = confirm.bound(instance),
        dismiss = dismiss?.bound(instance),
        child = child?.bound(instance),
      )
    is PrototypeIconButtonNode ->
      copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeFabNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        label = label?.let(instance::interpolate),
      )
    is PrototypeSegmentedButtonNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        options = options.map { it.copy(label = instance.interpolate(it.label)) },
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeTopAppBarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        title = instance.interpolate(title),
        navigationIcon = navigationIcon?.bound(instance),
        actions = actions?.map { it.bound(instance) },
      )
    is PrototypeDividerNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeBadgeNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeProgressNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeSnackbarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        text = instance.interpolate(text),
        action = action?.bound(instance),
      )
    is PrototypeTimePickerNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        hourKey = instance.interpolate(hourKey),
        minuteKey = instance.interpolate(minuteKey),
      )
    is PrototypeDatePickerNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
  }
}

private fun PrototypeDialogButton.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap?.map { it.bound(instance) })

private fun PrototypeListItemTrailing.bound(instance: RepeatInstance): PrototypeListItemTrailing =
  when (this) {
    is PrototypeListItemSwitch -> copy(stateKey = instance.interpolate(stateKey))
    is PrototypeListItemCheckbox -> copy(stateKey = instance.interpolate(stateKey))
    else -> this
  }

private fun PrototypeAppBarAction.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap?.map { it.bound(instance) })

private fun PrototypeAction.bound(instance: RepeatInstance): PrototypeAction =
  when (this) {
    is PrototypeSetStateAction ->
      copy(key = instance.interpolate(key), value = instance.interpolateScalar(value))
    is PrototypeEmitAction -> copy(name = instance.interpolate(name))
    is PrototypeToggleAction -> copy(key = instance.interpolate(key))
    is PrototypeIncrementAction -> copy(key = instance.interpolate(key))
    is PrototypeDecrementAction -> copy(key = instance.interpolate(key))
    else -> this
  }

private fun PrototypeCondition.bound(instance: RepeatInstance): PrototypeCondition =
  copy(
    key = key?.let(instance::interpolate),
    equals = equals?.let(instance::interpolateScalar),
    notEquals = notEquals?.let(instance::interpolateScalar),
    all = all?.map { it.bound(instance) },
    any = any?.map { it.bound(instance) },
    not = not?.bound(instance),
  )

/** A string operand: text values are interpolated, numbers and booleans pass through. */
private fun RepeatInstance.interpolateScalar(scalar: PrototypeScalar): PrototypeScalar =
  if (scalar is PrototypeScalar.Text) interpolateTyped(scalar.value) else scalar

/**
 * A string that is exactly one placeholder keeps the item's own type (so `equals: "{item.id}"` can
 * match a numeric state value); anything else renders to text.
 */
private fun RepeatInstance.interpolateTyped(text: String): PrototypeScalar {
  val only = PrototypeRepeatTemplate.segments(text, alias).singleOrNull()
  val typed =
    when (only) {
      is PrototypeRepeatSegment.Index -> PrototypeScalar.Numeric(index.toDouble())
      is PrototypeRepeatSegment.Field -> item[only.name]
      else -> null
    }
  return typed ?: PrototypeScalar.Text(interpolate(text))
}

/** Unknown fields cannot occur after validation; they are left as their literal placeholder. */
private fun RepeatInstance.interpolate(text: String): String =
  PrototypeRepeatTemplate.segments(text, alias).joinToString("") { segment ->
    when (segment) {
      is PrototypeRepeatSegment.Literal -> segment.text
      is PrototypeRepeatSegment.Index -> index.toString()
      is PrototypeRepeatSegment.Field ->
        item[segment.name]?.renderedText() ?: "{$alias.${segment.name}}"
    }
  }
