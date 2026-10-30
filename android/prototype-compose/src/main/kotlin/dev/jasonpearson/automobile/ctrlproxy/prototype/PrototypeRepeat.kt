package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.EmitContextBinding
import dev.jasonpearson.automobile.protocol.EmitContextResolver
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeAdaptiveNode
import dev.jasonpearson.automobile.protocol.PrototypeAppBarAction
import dev.jasonpearson.automobile.protocol.PrototypeAppendDataAction
import dev.jasonpearson.automobile.protocol.PrototypeBadgeNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomNavNode
import dev.jasonpearson.automobile.protocol.PrototypeBottomSheetNode
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCameraPreviewNode
import dev.jasonpearson.automobile.protocol.PrototypeCancelTimerAction
import dev.jasonpearson.automobile.protocol.PrototypeCardNode
import dev.jasonpearson.automobile.protocol.PrototypeCarouselNode
import dev.jasonpearson.automobile.protocol.PrototypeCastButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeChartNode
import dev.jasonpearson.automobile.protocol.PrototypeCheck
import dev.jasonpearson.automobile.protocol.PrototypeCheckboxNode
import dev.jasonpearson.automobile.protocol.PrototypeChipNode
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeDatePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeDecrementAction
import dev.jasonpearson.automobile.protocol.PrototypeDerivedRows
import dev.jasonpearson.automobile.protocol.PrototypeDialogButton
import dev.jasonpearson.automobile.protocol.PrototypeDialogNode
import dev.jasonpearson.automobile.protocol.PrototypeDividerNode
import dev.jasonpearson.automobile.protocol.PrototypeDrawerNode
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
import dev.jasonpearson.automobile.protocol.PrototypeListNode
import dev.jasonpearson.automobile.protocol.PrototypeMapNode
import dev.jasonpearson.automobile.protocol.PrototypeMenuEntry
import dev.jasonpearson.automobile.protocol.PrototypeMenuNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypePagerNode
import dev.jasonpearson.automobile.protocol.PrototypePasteButtonNode
import dev.jasonpearson.automobile.protocol.PrototypePrependDataAction
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
import dev.jasonpearson.automobile.protocol.PrototypeTooltipNode
import dev.jasonpearson.automobile.protocol.PrototypeTopAppBarNode
import dev.jasonpearson.automobile.protocol.PrototypeValidityKeys
import dev.jasonpearson.automobile.protocol.PrototypeVideoPlayerNode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/** A child to render and the path it is rendered under (also its stable Compose identity). */
internal data class PrototypeChildEntry(
  val node: PrototypeNode,
  val path: String,
  val enterDelayMs: Int = 0,
)

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
private fun hasSingleChild(node: PrototypeNode): Boolean =
  node is PrototypeScrollNode ||
    node is PrototypeBottomSheetNode ||
    node is PrototypeDrawerNode ||
    node is PrototypeDialogNode ||
    node is PrototypeSearchBarNode

private fun adaptiveChildEntries(
  node: PrototypeAdaptiveNode,
  path: String,
): List<PrototypeChildEntry> =
  listOfNotNull(
    node.list?.let { PrototypeChildEntry(it, "$path.list") },
    node.detail?.let { PrototypeChildEntry(it, "$path.detail") },
    node.content?.let { PrototypeChildEntry(it, "$path.content") },
    node.main?.let { PrototypeChildEntry(it, "$path.main") },
    node.supporting?.let { PrototypeChildEntry(it, "$path.supporting") },
  )

internal fun prototypeChildEntries(
  node: PrototypeNode,
  path: String,
  bind: Boolean = true,
  formatter: PrototypeValueFormatter = AndroidPrototypeValueFormatter(),
): List<PrototypeChildEntry> {
  if (node is PrototypeAdaptiveNode) return adaptiveChildEntries(node, path)
  if (node is PrototypeListNode)
    return listOfNotNull(
      node.header?.let { PrototypeChildEntry(it, "$path.header") },
      PrototypeChildEntry(node.children.single(), "$path.children[0]"),
      node.footer?.let { PrototypeChildEntry(it, "$path.footer") },
    )
  if (node is PrototypeStackNode)
    return node.screens.map { (name, child) ->
      PrototypeChildEntry(child, "$path.screens[${JsonPrimitive(name)}]")
    }
  val children = prototypeDescendants(node)
  val repeat = node.repeatSpec()
  if (repeat == null) {
    val single = hasSingleChild(node)
    return children.mapIndexed { index, child ->
      PrototypeChildEntry(child, if (single) "$path.child" else "$path.children[$index]")
    }
  }
  val rows = projectedRepeatRows(node, repeat, path, bind, formatter)
  return rows.flatMapIndexed { itemIndex, projected ->
    val instance = RepeatInstance(repeat.`as`, projected, itemIndex)
    val identity =
      if (bind) repeat.key?.let { projected[it]?.renderedText() } ?: itemIndex.toString()
      else itemIndex.toString()
    children.mapIndexed { index, child ->
      PrototypeChildEntry(
        if (bind) child.bound(instance) else child,
        "$path.repeat[$identity].children[$index]",
        if (child.visibleWhen != null) (itemIndex * (repeat.stagger ?: 0)).coerceAtMost(600) else 0,
      )
    }
  }
}

private fun projectedRepeatRows(
  node: PrototypeNode,
  repeat: PrototypeRepeat,
  path: String,
  bind: Boolean,
  formatter: PrototypeValueFormatter,
): List<Map<String, PrototypeScalar>> {
  if (!bind || repeat.derive.isNullOrEmpty()) return repeat.items
  val derive = repeat.derive.orEmpty()
  // Relative strings are snapshots when this list is built, refreshed when its source changes.
  val rows =
    repeat.items.map { item ->
      item +
        derive.mapValues { (_, entry) ->
          val input =
            if ("value" in entry.of) entry.of["value"]
            else
              item[entry.of.getValue("item").jsonPrimitive.content]?.let(
                EmitContextResolver::scalar,
              )
          PrototypeScalar.Text(formatter.format(entry, input))
        }
    }
  val error = PrototypeDerivedRows.validate(node, rows)
  require(error == null) { "$path${error?.path?.removePrefix("root")}: ${error?.message}" }
  return rows
}

private fun PrototypeNode.bound(instance: RepeatInstance): PrototypeNode {
  val semantics = semantics?.let {
    it.copy(
      label = it.label?.let(instance::interpolate),
      hint = it.hint?.let(instance::interpolate),
    )
  }
  val onAppear = onAppear?.map { it.bound(instance) }
  val onTap = onTap?.map { it.bound(instance) }
  val onLongPress = onLongPress?.map { it.bound(instance) }
  val onDoubleTap = onDoubleTap?.map { it.bound(instance) }
  val styleWhen = styleWhen?.map { PrototypeStyleWhen(it.`when`.bound(instance), it.style) }
  val visibleWhen = visibleWhen?.bound(instance)
  val shared = shared?.let { it.copy(key = instance.interpolate(it.key)) }
  fun List<PrototypeNode>.bound() = map { it.bound(instance) }
  return when (this) {
    is PrototypeBoxNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeRowNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        swipeActions = swipeActions?.bound(instance),
        children = children.bound(),
      )
    is PrototypeColumnNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeFlowNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeGridNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeCarouselNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeStackNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        screens = screens.mapValues { (_, child) -> child.bound(instance) },
      )
    is PrototypePagerNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeCardNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        children = children.bound(),
      )
    is PrototypeTextNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
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
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
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
    is PrototypeTooltipNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        text = instance.interpolate(text),
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        onDismiss = onDismiss?.map { it.bound(instance) },
      )
    is PrototypeDrawerNode ->
      copy(
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        child = child.bound(instance),
      )
    is PrototypeBottomSheetNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        child = child.bound(instance),
      )
    is PrototypeImageNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeIconNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        onLongPress = onLongPress,
        onDoubleTap = onDoubleTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeSpacerNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeSearchBarNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
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
        errorWhen = errorWhen?.bound(instance),
        errorText = errorText?.let(instance::interpolate),
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeTabBarNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeAdaptiveNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        list = list?.bound(instance),
        detail = detail?.bound(instance),
        content = content?.bound(instance),
        main = main?.bound(instance),
        supporting = supporting?.bound(instance),
        selectionKey = selectionKey?.let(instance::interpolate),
        stateKey = stateKey?.let(instance::interpolate),
        openKey = openKey?.let(instance::interpolate),
      )
    is PrototypeBottomNavNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeSwitchNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeCheckboxNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypePasteButtonNode ->
      copy(
        into = instance.dataPath(into),
        semantics = semantics,
        onAppear = onAppear,
        styleWhen = styleWhen,
        visibleWhen = visibleWhen,
      )
    is PrototypeButtonNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        label = instance.interpolate(label),
      )
    is PrototypeSliderNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeChipNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    is PrototypeRadioGroupNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeSelectNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = instance.interpolate(stateKey),
        label = label?.let(instance::interpolate),
        options = options.map { it.copy(label = instance.interpolate(it.label)) },
      )
    is PrototypeMenuNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
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
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        trailing = trailing?.bound(instance),
        swipeActions = swipeActions?.bound(instance),
      )
    is PrototypeDialogNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
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
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeFabNode ->
      copy(
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        label = label?.let(instance::interpolate),
      )
    is PrototypeSegmentedButtonNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        options = options.map { it.copy(label = instance.interpolate(it.label)) },
        stateKey = instance.interpolate(stateKey),
      )
    is PrototypeTopAppBarNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        title = instance.interpolate(title),
        navigationIcon = navigationIcon?.bound(instance),
        actions = actions?.map { it.bound(instance) },
      )
    is PrototypeDividerNode ->
      copy(
        semantics = semantics,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeBadgeNode ->
      copy(
        semantics = semantics,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeDividerNode ->
      copy(
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeBadgeNode ->
      copy(
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeProgressNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        stateKey = stateKey?.let(instance::interpolate),
      )
    // Contract only (#14253, #14239, #14202): no renderer draws these media nodes yet.
    is PrototypeVideoPlayerNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeCastButtonNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    // Contract only (#14309): no renderer draws a map yet.
    is PrototypeMapNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeCameraPreviewNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
      )
    is PrototypeListNode -> this // Nested lists in repeat templates are rejected by validation.
    is PrototypeChartNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        series = series.map { it.copy(path = instance.interpolate(it.path)) },
      )
    is PrototypeSnackbarNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        openWhen = openWhen.copy(key = instance.interpolate(openWhen.key)),
        text = instance.interpolate(text),
        action = action?.bound(instance),
      )
    is PrototypeTimePickerNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        hourKey = instance.interpolate(hourKey),
        minuteKey = instance.interpolate(minuteKey),
      )
    is PrototypeDatePickerNode ->
      copy(
        checks = checks?.map { it.bound(instance) },
        enabledWhen = enabledWhen?.bound(instance),
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
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

private fun PrototypeRequestAction.boundRequest(instance: RepeatInstance) =
  copy(
    url = instance.interpolate(url),
    headers = headers?.mapValues { (_, entry) -> instance.requestEntry(entry) },
    query = query?.mapValues { (_, entry) -> instance.requestEntry(entry) },
    body = body?.let(instance::dataValue),
    into = into?.let(instance::dataPath),
    append = append?.let { it.copy(to = instance.dataPath(it.to)) },
    statusKey = statusKey?.let(instance::interpolate),
    onSuccess = onSuccess?.map { it.bound(instance) },
    onError = onError?.map { it.bound(instance) },
  )

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
    is PrototypeStartTimerAction -> copy(actions = actions.map { it.bound(instance) })
    is PrototypeCancelTimerAction -> this
    is PrototypeRequestAction -> boundRequest(instance)
    is PrototypeToggleAction -> copy(key = instance.interpolate(key))
    is PrototypeIncrementAction -> copy(key = instance.interpolate(key))
    is PrototypeDecrementAction -> copy(key = instance.interpolate(key))
    else -> boundDataAction(instance) ?: this
  }

private fun PrototypeAction.boundDataAction(instance: RepeatInstance): PrototypeAction? =
  when (this) {
    is PrototypeSetDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataValue(value))
    is PrototypePrependDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataValue(value))
    is PrototypeAppendDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataValue(value))
    is PrototypeRemoveDataAction -> copy(path = instance.dataPath(path))
    else -> null
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
    contains = contains?.let(instance::interpolateText),
    startsWith = startsWith?.let(instance::interpolateText),
    all = all?.map { it.bound(instance) },
    any = any?.map { it.bound(instance) },
    not = not?.bound(instance),
  )

/** A string operand: text values are interpolated, numbers and booleans pass through. */
private fun RepeatInstance.interpolateScalar(scalar: PrototypeScalar): PrototypeScalar =
  if (scalar is PrototypeScalar.Text) interpolateTyped(scalar.value) else scalar

/**
 * A substring operand always binds as text, so `contains: "{item.n}"` matches the rendered number.
 */
private fun RepeatInstance.interpolateText(scalar: PrototypeScalar): PrototypeScalar =
  if (scalar is PrototypeScalar.Text) PrototypeScalar.Text(interpolate(scalar.value)) else scalar

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

/** Bind only the row requested by the lazy composition. */
internal fun bindPrototypeListRow(
  node: PrototypeListNode,
  item: JsonObject,
  index: Int,
): PrototypeNode =
  node.children
    .single()
    .bound(
      RepeatInstance(
        node.repeat.`as`,
        item.mapValues { (_, value) ->
          kotlinx.serialization.json.Json.decodeFromJsonElement(PrototypeScalar.serializer(), value)
        },
        index,
      ),
    )
