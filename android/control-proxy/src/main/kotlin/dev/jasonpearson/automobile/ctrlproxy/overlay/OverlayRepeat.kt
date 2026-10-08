package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayAction
import dev.jasonpearson.automobile.protocol.OverlayAppBarAction
import dev.jasonpearson.automobile.protocol.OverlayBadgeNode
import dev.jasonpearson.automobile.protocol.OverlayBottomNavNode
import dev.jasonpearson.automobile.protocol.OverlayBottomSheetNode
import dev.jasonpearson.automobile.protocol.OverlayBoxNode
import dev.jasonpearson.automobile.protocol.OverlayButtonNode
import dev.jasonpearson.automobile.protocol.OverlayCardNode
import dev.jasonpearson.automobile.protocol.OverlayCheckboxNode
import dev.jasonpearson.automobile.protocol.OverlayChipNode
import dev.jasonpearson.automobile.protocol.OverlayColumnNode
import dev.jasonpearson.automobile.protocol.OverlayCondition
import dev.jasonpearson.automobile.protocol.OverlayDatePickerNode
import dev.jasonpearson.automobile.protocol.OverlayDialogButton
import dev.jasonpearson.automobile.protocol.OverlayDialogNode
import dev.jasonpearson.automobile.protocol.OverlayDividerNode
import dev.jasonpearson.automobile.protocol.OverlayEmitAction
import dev.jasonpearson.automobile.protocol.OverlayFabNode
import dev.jasonpearson.automobile.protocol.OverlayIconButtonNode
import dev.jasonpearson.automobile.protocol.OverlayIconNode
import dev.jasonpearson.automobile.protocol.OverlayImageNode
import dev.jasonpearson.automobile.protocol.OverlayListItemNode
import dev.jasonpearson.automobile.protocol.OverlayNode
import dev.jasonpearson.automobile.protocol.OverlayPagerNode
import dev.jasonpearson.automobile.protocol.OverlayProgressNode
import dev.jasonpearson.automobile.protocol.OverlayRadioGroupNode
import dev.jasonpearson.automobile.protocol.OverlayRepeat
import dev.jasonpearson.automobile.protocol.OverlayRepeatSegment
import dev.jasonpearson.automobile.protocol.OverlayRepeatTemplate
import dev.jasonpearson.automobile.protocol.OverlayRowNode
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlayScrollNode
import dev.jasonpearson.automobile.protocol.OverlaySegmentedButtonNode
import dev.jasonpearson.automobile.protocol.OverlaySetStateAction
import dev.jasonpearson.automobile.protocol.OverlaySliderNode
import dev.jasonpearson.automobile.protocol.OverlaySnackbarNode
import dev.jasonpearson.automobile.protocol.OverlaySpacerNode
import dev.jasonpearson.automobile.protocol.OverlayStyleWhen
import dev.jasonpearson.automobile.protocol.OverlaySwitchNode
import dev.jasonpearson.automobile.protocol.OverlayTabBarNode
import dev.jasonpearson.automobile.protocol.OverlayTextFieldNode
import dev.jasonpearson.automobile.protocol.OverlayTextNode
import dev.jasonpearson.automobile.protocol.OverlayTimePickerNode
import dev.jasonpearson.automobile.protocol.OverlayTopAppBarNode
import java.math.BigDecimal

/** A child to render and the path it is rendered under (also its stable Compose identity). */
internal data class OverlayChildEntry(val node: OverlayNode, val path: String)

private data class RepeatInstance(
  val alias: String,
  val item: Map<String, OverlayScalar>,
  val index: Int,
)

private fun OverlayNode.repeatSpec(): OverlayRepeat? =
  when (this) {
    is OverlayBoxNode -> repeat
    is OverlayRowNode -> repeat
    is OverlayColumnNode -> repeat
    else -> null
  }

/**
 * The children [node] renders, with `repeat` expanded before layout: the template children are
 * instantiated once per item, in item order, each bound to its item and `{index}`. Instance
 * children live under `path.repeat[item].children[template]`, so a row keeps its identity (and its
 * Compose key) for as long as it keeps its index. Without a `repeat` this is the plain child list.
 * Pass [bind] false to walk the shape only (limit guards) without copying any node.
 */
internal fun overlayChildEntries(
  node: OverlayNode,
  path: String,
  bind: Boolean = true,
): List<OverlayChildEntry> {
  val children = overlayDescendants(node)
  val repeat = node.repeatSpec()
  if (repeat == null) {
    val single =
      node is OverlayScrollNode || node is OverlayBottomSheetNode || node is OverlayDialogNode
    return children.mapIndexed { index, child ->
      OverlayChildEntry(child, if (single) "$path.child" else "$path.children[$index]")
    }
  }
  return repeat.items.flatMapIndexed { itemIndex, item ->
    val instance = RepeatInstance(repeat.`as`, item, itemIndex)
    children.mapIndexed { index, child ->
      OverlayChildEntry(
        if (bind) child.bound(instance) else child,
        "$path.repeat[$itemIndex].children[$index]",
      )
    }
  }
}

private fun OverlayNode.bound(instance: RepeatInstance): OverlayNode {
  val onTap = onTap?.map { it.bound(instance) }
  val styleWhen = styleWhen?.map { OverlayStyleWhen(it.`when`.bound(instance), it.style) }
  val visibleWhen = visibleWhen?.bound(instance)
  fun List<OverlayNode>.bound() = map { it.bound(instance) }
  return when (this) {
    is OverlayBoxNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is OverlayRowNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is OverlayColumnNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is OverlayPagerNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is OverlayCardNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is OverlayTextNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        text = instance.interpolate(text),
      )
    is OverlayScrollNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        child = child.bound(instance),
      )
    is OverlayBottomSheetNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        child = child.bound(instance),
      )
    is OverlayImageNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayIconNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlaySpacerNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayTextFieldNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayTabBarNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayBottomNavNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlaySwitchNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayCheckboxNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayButtonNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        label = instance.interpolate(label),
      )
    is OverlaySliderNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayChipNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayRadioGroupNode ->
      copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayListItemNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayDialogNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        title = title?.let(instance::interpolate),
        text = text?.let(instance::interpolate),
        confirm = confirm.bound(instance),
        dismiss = dismiss?.bound(instance),
        child = child?.bound(instance),
      )
    is OverlayIconButtonNode ->
      copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayFabNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        label = label?.let(instance::interpolate),
      )
    is OverlaySegmentedButtonNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        options = options.map { it.copy(label = instance.interpolate(it.label)) },
      )
    is OverlayTopAppBarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        title = instance.interpolate(title),
        navigationIcon = navigationIcon?.bound(instance),
        actions = actions?.map { it.bound(instance) },
      )
    is OverlayDividerNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayBadgeNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayProgressNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlaySnackbarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        text = instance.interpolate(text),
        action = action?.bound(instance),
      )
    is OverlayTimePickerNode ->
      copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is OverlayDatePickerNode ->
      copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
  }
}

private fun OverlayDialogButton.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap?.map { it.bound(instance) })

private fun OverlayAppBarAction.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap?.map { it.bound(instance) })

private fun OverlayAction.bound(instance: RepeatInstance): OverlayAction =
  when (this) {
    is OverlaySetStateAction -> copy(value = instance.interpolateScalar(value))
    is OverlayEmitAction -> copy(name = instance.interpolate(name))
    else -> this
  }

private fun OverlayCondition.bound(instance: RepeatInstance): OverlayCondition =
  copy(
    equals = equals?.let(instance::interpolateScalar),
    notEquals = notEquals?.let(instance::interpolateScalar),
    all = all?.map { it.bound(instance) },
    any = any?.map { it.bound(instance) },
    not = not?.bound(instance),
  )

/** A string operand: text values are interpolated, numbers and booleans pass through. */
private fun RepeatInstance.interpolateScalar(scalar: OverlayScalar): OverlayScalar =
  if (scalar is OverlayScalar.Text) interpolateTyped(scalar.value) else scalar

/**
 * A string that is exactly one placeholder keeps the item's own type (so `equals: "{item.id}"` can
 * match a numeric state value); anything else renders to text.
 */
private fun RepeatInstance.interpolateTyped(text: String): OverlayScalar {
  val only = OverlayRepeatTemplate.segments(text, alias).singleOrNull()
  val typed =
    when (only) {
      is OverlayRepeatSegment.Index -> OverlayScalar.Numeric(index.toDouble())
      is OverlayRepeatSegment.Field -> item[only.name]
      else -> null
    }
  return typed ?: OverlayScalar.Text(interpolate(text))
}

/** Unknown fields cannot occur after validation; they are left as their literal placeholder. */
private fun RepeatInstance.interpolate(text: String): String =
  OverlayRepeatTemplate.segments(text, alias).joinToString("") { segment ->
    when (segment) {
      is OverlayRepeatSegment.Literal -> segment.text
      is OverlayRepeatSegment.Index -> index.toString()
      is OverlayRepeatSegment.Field -> item[segment.name]?.rendered() ?: "{$alias.${segment.name}}"
    }
  }

private fun OverlayScalar.rendered(): String =
  when (this) {
    is OverlayScalar.Text -> value
    is OverlayScalar.BooleanValue -> value.toString()
    is OverlayScalar.Numeric ->
      // Integral values render without a decimal point or exponent at any magnitude.
      if (value.isFinite() && value == Math.floor(value)) {
        BigDecimal(value).toPlainString()
      } else {
        value.toString()
      }
  }
