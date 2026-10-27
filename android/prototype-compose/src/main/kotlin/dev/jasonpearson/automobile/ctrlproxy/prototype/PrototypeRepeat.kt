package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.EmitContextBinding
import dev.jasonpearson.automobile.protocol.EmitContextResolver
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeAppBarAction
import dev.jasonpearson.automobile.protocol.PrototypeAppendDataAction
import dev.jasonpearson.automobile.protocol.PrototypeBadgeNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomNavNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomSheetNode
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCancelTimerAction
import dev.jasonpearson.automobile.protocol.PrototypeCardNode
import dev.jasonpearson.automobile.protocol.PrototypeCarouselNode
import dev.jasonpearson.automobile.protocol.PrototypeChartNode
import dev.jasonpearson.automobile.protocol.PrototypeCheck
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
import dev.jasonpearson.automobile.protocol.PrototypeFlowNode
import dev.jasonpearson.automobile.protocol.PrototypeGridNode
import dev.jasonpearson.automobile.protocol.PrototypeIconButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeIconNode
import dev.jasonpearson.automobile.protocol.PrototypeImageNode
import dev.jasonpearson.automobile.protocol.PrototypeIncrementAction
import dev.jasonpearson.automobile.protocol.PrototypeListItemCheckbox
import dev.jasonpearson.automobile.protocol.PrototypeListItemNode
import dev.jasonpearson.automobile.protocol.PrototypeListItemSwitch
import dev.jasonpearson.automobile.protocol.PrototypeListItemTrailing
import dev.jasonpearson.automobile.protocol.PrototypeMenuEntry
import dev.jasonpearson.automobile.protocol.PrototypeMenuNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypePagerNode
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import dev.jasonpearson.automobile.protocol.PrototypeRadioGroupNode
import dev.jasonpearson.automobile.protocol.PrototypeRemoveDataAction
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeRepeatNodeBinding
import dev.jasonpearson.automobile.protocol.PrototypeRepeatSegment
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTemplate
import dev.jasonpearson.automobile.protocol.PrototypeRequestAction
import dev.jasonpearson.automobile.protocol.PrototypeRowNode
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeScrollNode
import dev.jasonpearson.automobile.protocol.PrototypeSearchBarNode
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeSelectNode
import dev.jasonpearson.automobile.protocol.PrototypeSetDataAction
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeSliderNode
import dev.jasonpearson.automobile.protocol.PrototypeSnackbarNode
import dev.jasonpearson.automobile.protocol.PrototypeSpacerNode
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.PrototypeStartTimerAction
import dev.jasonpearson.automobile.protocol.PrototypeStyleWhen
import dev.jasonpearson.automobile.protocol.PrototypeSwipeAction
import dev.jasonpearson.automobile.protocol.PrototypeSwipeActions
import dev.jasonpearson.automobile.protocol.PrototypeSwitchNode
import dev.jasonpearson.automobile.protocol.PrototypeTabBarNode
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction
import dev.jasonpearson.automobile.protocol.PrototypeTopAppBarNode
import dev.jasonpearson.automobile.protocol.PrototypeValidityKeys
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

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
    is PrototypeFlowNode -> repeat
    is PrototypeGridNode -> repeat
    is PrototypeCarouselNode -> repeat
    else -> null
  }

/**
 * The children [node] renders, with `repeat` expanded before layout: the template children are
 * instantiated once per item, in item order. With [bind] true, each child is bound to its item and
 * `{index}` and lives under `path.repeat[key].children[template]`, using `repeat.key` when present
 * and falling back to its index, so a row keeps its identity (and its Compose key). Pass [bind]
 * false to walk the shape only (limit guards and anchor validation) without copying any node; these
 * walks always use `path.repeat[index].children[template]` to preserve validation paths. Without a
 * `repeat` this is the plain child list.
 */
internal fun prototypeChildEntries(
  node: PrototypeNode,
  path: String,
  bind: Boolean = true,
): List<PrototypeChildEntry> {
  if (node is PrototypeStackNode)
    return node.screens.map { (name, child) ->
      PrototypeChildEntry(child, "$path.screens[${JsonPrimitive(name)}]")
    }
  val children = prototypeDescendants(node)
  val repeat = node.repeatSpec()
  if (repeat == null) {
    val single =
      node is PrototypeScrollNode ||
        node is PrototypeBottomSheetNode ||
        node is PrototypeDialogNode ||
        node is PrototypeSearchBarNode
    return children.mapIndexed { index, child ->
      PrototypeChildEntry(child, if (single) "$path.child" else "$path.children[$index]")
    }
  }
  return repeat.items.flatMapIndexed { itemIndex, item ->
    val instance = RepeatInstance(repeat.`as`, item, itemIndex)
    val identity =
      if (bind) repeat.key?.let { item[it]?.renderedText() } ?: itemIndex.toString()
      else itemIndex.toString()
    children.mapIndexed { index, child ->
      PrototypeChildEntry(
        if (bind) child.bound(instance) else child,
        "$path.repeat[$identity].children[$index]",
      )
    }
  }
}

private fun PrototypeNode.bound(instance: RepeatInstance): PrototypeNode {
  val onTap = onTap?.map { it.bound(instance) }
  val onLongPress = onLongPress?.map { it.bound(instance) }
  val onDoubleTap = onDoubleTap?.map { it.bound(instance) }
  val styleWhen = styleWhen?.map { PrototypeStyleWhen(it.`when`.bound(instance), it.style) }
  val visibleWhen = visibleWhen?.bound(instance)
  fun List<PrototypeNode>.bound() = map { it.bound(instance) }
  return when (this) {
    is PrototypeBoxNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeRowNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        swipeActions = swipeActions?.bound(instance),
        children = children.bound(),
      )
    is PrototypeColumnNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeFlowNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeGridNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeCarouselNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeStackNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        screens = screens.mapValues { (_, child) -> child.bound(instance) },
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
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeTextNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        text = text?.let(instance::interpolate),
        linkify =
          linkify?.let { options ->
            val node =
              JsonObject(
                mapOf(
                  "type" to JsonPrimitive("text"),
                  "linkify" to JsonObject(mapOf("onTap" to options.onTap)),
                ),
              )
            val bound =
              PrototypeRepeatNodeBinding.bindNodeFields(
                node,
                instance.alias,
                instance.item.mapValues { (_, value) -> EmitContextResolver.scalar(value) },
                instance.index,
              )
            options.copy(
              onTap = (bound.getValue("linkify") as JsonObject).getValue("onTap") as JsonArray,
            )
          },
        spans =
          spans?.map { span ->
            span.copy(
              text = instance.interpolate(span.text),
              onTap = span.onTap?.map { it.bound(instance) },
            )
          },
      )
    is PrototypeScrollNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        refresh =
          refresh?.let {
            it.copy(
              stateKey = instance.interpolate(it.stateKey),
              onRefresh = it.onRefresh.map { action -> action.bound(instance) },
            )
          },
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
    is PrototypeImageNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
      )
    is PrototypeIconNode ->
      copy(
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
      )
    is PrototypeSpacerNode -> copy(onTap = onTap, styleWhen = styleWhen, visibleWhen = visibleWhen)
    is PrototypeSearchBarNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
        activeKey = activeKey?.let(instance::interpolate),
        placeholder = placeholder?.let(instance::interpolate),
        trailingActions = trailingActions?.map { it.bound(instance) },
        onSubmit = onSubmit?.map { it.bound(instance) },
        child = child?.bound(instance),
      )
    is PrototypeTextFieldNode ->
      copy(
        trailingIcon = trailingIcon?.bound(instance),
        onSubmit = onSubmit?.map { it.bound(instance) },
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
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
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeCheckboxNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeButtonNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        label = instance.interpolate(label),
      )
    is PrototypeSliderNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeChipNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeRadioGroupNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeSelectNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
        label = label?.let(instance::interpolate),
        options = options.map { it.copy(label = instance.interpolate(it.label)) },
      )
    is PrototypeMenuNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        items =
          items.map { item ->
            if (item is PrototypeMenuEntry)
              item.copy(
                label = instance.interpolate(item.label),
                trailingText = item.trailingText?.let(instance::interpolate),
                onTap = item.onTap?.map { it.bound(instance) },
              )
            else item
          },
      )
    is PrototypeListItemNode ->
      copy(
        headline = instance.interpolate(headline),
        supporting = supporting?.let(instance::interpolate),
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        trailing = trailing?.bound(instance),
        swipeActions = swipeActions?.bound(instance),
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
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
      )
    is PrototypeFabNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
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
    is PrototypeChartNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        series = series.map { it.copy(path = instance.interpolate(it.path)) },
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
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        onTap = onTap,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
        hourKey = instance.interpolate(hourKey),
        minuteKey = instance.interpolate(minuteKey),
      )
    is PrototypeDatePickerNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
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

private fun PrototypeSwipeActions.bound(instance: RepeatInstance) =
  copy(start = start?.map { it.bound(instance) }, end = end?.map { it.bound(instance) })

private fun PrototypeSwipeAction.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap.map { it.bound(instance) })

private fun PrototypeAppBarAction.bound(instance: RepeatInstance) =
  copy(label = instance.interpolate(label), onTap = onTap?.map { it.bound(instance) })

private fun PrototypeAction.bound(instance: RepeatInstance): PrototypeAction =
  when (this) {
    is PrototypeSetStateAction ->
      copy(key = instance.interpolate(key), value = instance.interpolateScalar(value))
    is PrototypeEmitAction ->
      copy(
        name = instance.interpolate(name),
        requireValid = requireValid?.map(instance::interpolate),
        context =
          context?.let {
            PrototypeRepeatTemplate.bindEmitContext(
              it,
              instance.alias,
              instance.item.mapValues { (_, value) -> EmitContextResolver.scalar(value) },
              instance.index,
            )
          },
      )
    is PrototypeSetDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataValue(value))
    is PrototypeAppendDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataValue(value))
    is PrototypeRemoveDataAction -> copy(path = instance.dataPath(path))
    is PrototypeStartTimerAction -> copy(actions = actions.map { it.bound(instance) })
    is PrototypeCancelTimerAction -> this
    is PrototypeRequestAction ->
      copy(
        url = instance.interpolate(url),
        headers = headers?.mapValues { (_, entry) -> instance.requestEntry(entry) },
        query = query?.mapValues { (_, entry) -> instance.requestEntry(entry) },
        body = body?.let(instance::dataValue),
        into = into?.let(instance::dataPath),
        statusKey = statusKey?.let(instance::interpolate),
        onSuccess = onSuccess?.map { it.bound(instance) },
        onError = onError?.map { it.bound(instance) },
      )
    is PrototypeToggleAction -> copy(key = instance.interpolate(key))
    is PrototypeIncrementAction -> copy(key = instance.interpolate(key))
    is PrototypeDecrementAction -> copy(key = instance.interpolate(key))
    else -> this
  }

/** Only a whole `{index}` segment binds in a data path; the validator refuses anything else. */
private fun RepeatInstance.dataPath(path: String): String =
  PrototypeRepeatTemplate.bindDataPath(path, index)

/** A header or query entry: a literal string interpolates, a binding binds like a data value. */
private fun RepeatInstance.requestEntry(entry: JsonElement): JsonElement =
  if (entry is JsonObject) dataValue(entry)
  else JsonPrimitive(interpolate(entry.jsonPrimitive.content))

/** `{item}` and `{index}` become literals of this row; `{state}` keys interpolate. */
private fun RepeatInstance.dataValue(binding: EmitContextBinding): EmitContextBinding =
  PrototypeRepeatTemplate.bindBinding(
    binding,
    alias,
    item.mapValues { (_, value) -> EmitContextResolver.scalar(value) },
    index,
  )

private fun PrototypeCondition.bound(instance: RepeatInstance): PrototypeCondition =
  copy(
    valid = valid?.let { PrototypeValidityKeys.Multiple(it.keys().map(instance::interpolate)) },
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

private fun PrototypeCheck.bound(instance: RepeatInstance): PrototypeCheck {
  val message = instance.interpolate(message)
  return when (this) {
    is PrototypeCheck.Required -> copy(message = message)
    is PrototypeCheck.MinLength -> copy(message = message)
    is PrototypeCheck.MaxLength -> copy(message = message)
    is PrototypeCheck.Min -> copy(message = message)
    is PrototypeCheck.Max -> copy(message = message)
    is PrototypeCheck.Format -> copy(message = message)
    is PrototypeCheck.Pattern -> copy(message = message)
  }
}
