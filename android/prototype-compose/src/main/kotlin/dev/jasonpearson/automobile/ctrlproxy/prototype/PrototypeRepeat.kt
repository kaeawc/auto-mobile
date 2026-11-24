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
import dev.jasonpearson.automobile.protocol.PrototypeDataWhere
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
import dev.jasonpearson.automobile.protocol.PrototypeLoadingIndicatorNode
import dev.jasonpearson.automobile.protocol.PrototypeMapNode
import dev.jasonpearson.automobile.protocol.PrototypeMenuEntry
import dev.jasonpearson.automobile.protocol.PrototypeMenuNode
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeObjectDataValue
import dev.jasonpearson.automobile.protocol.PrototypePagerNode
import dev.jasonpearson.automobile.protocol.PrototypePasteButtonNode
import dev.jasonpearson.automobile.protocol.PrototypePlatformAction
import dev.jasonpearson.automobile.protocol.PrototypePrependDataAction
import dev.jasonpearson.automobile.protocol.PrototypeProgressNode
import dev.jasonpearson.automobile.protocol.PrototypePushAction
import dev.jasonpearson.automobile.protocol.PrototypeRadioGroupNode
import dev.jasonpearson.automobile.protocol.PrototypeRemoveDataAction
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeRepeatNodeBinding
import dev.jasonpearson.automobile.protocol.PrototypeRepeatSegment
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTemplate
import dev.jasonpearson.automobile.protocol.PrototypeReplaceAction
import dev.jasonpearson.automobile.protocol.PrototypeRequestAction
import dev.jasonpearson.automobile.protocol.PrototypeRowNode
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeScrollNode
import dev.jasonpearson.automobile.protocol.PrototypeSearchBarNode
import dev.jasonpearson.automobile.protocol.PrototypeSegmentedButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeSelectNode
import dev.jasonpearson.automobile.protocol.PrototypeSetDataAction
import dev.jasonpearson.automobile.protocol.PrototypeSetStackAction
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
import dev.jasonpearson.automobile.protocol.PrototypeTextShield
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction
import dev.jasonpearson.automobile.protocol.PrototypeTooltipNode
import dev.jasonpearson.automobile.protocol.PrototypeTopAppBarNode
import dev.jasonpearson.automobile.protocol.PrototypeUpsertDataAction
import dev.jasonpearson.automobile.protocol.PrototypeValidityKeys
import dev.jasonpearson.automobile.protocol.PrototypeVideoPlayerNode
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
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
  val source: JsonObject = JsonObject(emptyMap()),
  val outerAlias: String? = null,
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

/** Whether [node]'s literal repeat items hold a `{`, so its rows may insert shielded values. */
internal fun prototypeRepeatItemsHaveBrace(node: PrototypeNode): Boolean =
  node.repeatSpec()?.items.orEmpty().any { row ->
    row.values.any { (it as? PrototypeScalar.Text)?.value?.contains('{') == true }
  }

internal fun prototypeRepeatDerivedName(node: PrototypeNode): String? =
  node.repeatSpec()?.itemsDerived

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
  return repeatedChildEntries(children, repeat, rows, path, bind)
}

private fun repeatedChildEntries(
  children: List<PrototypeNode>,
  repeat: PrototypeRepeat,
  rows: List<Map<String, PrototypeScalar>>,
  path: String,
  bind: Boolean,
): List<PrototypeChildEntry> {
  return rows.flatMapIndexed { itemIndex, projected ->
    val instance =
      RepeatInstance(
        repeat.`as`,
        projected,
        itemIndex,
        repeat.sourceItems?.getOrNull(itemIndex)
          ?: JsonObject(projected.mapValues { EmitContextResolver.scalar(it.value) }),
        repeat.outerAlias,
      )
    val identity =
      if (bind) repeat.key?.let { projected[it]?.renderedText() } ?: itemIndex.toString()
      else itemIndex.toString()
    children.mapIndexed { index, child ->
      PrototypeChildEntry(
        if (bind || repeat.sourceItems != null) child.bound(instance) else child,
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
  val error = PrototypeDerivedRows.validate(node, rows, repeat.sourceItems, repeat.outerAlias)
  require(error == null) { "$path${error?.path?.removePrefix("root")}: ${error?.message}" }
  return rows
}

private fun PrototypeNode.bound(instance: RepeatInstance): PrototypeNode {
  val nested = repeatSpec()?.takeIf { it.itemsField != null }
  val resolvedRepeat = nested?.let { repeat ->
    val raw =
      (instance.source[checkNotNull(repeat.itemsField)] as? JsonArray)
        .orEmpty()
        .filterIsInstance<JsonObject>()
        .take(
          dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
            .MAX_PROTOTYPE_INNER_REPEAT_ITEMS,
        )
    val outer =
      instance.item.mapKeys { (key, _) -> "outer.$key" } +
        ("\$outerIndex" to PrototypeScalar.Numeric(instance.index.toDouble()))
    repeat.copy(
      itemsField = null,
      sourceItems = raw,
      outerAlias = instance.alias,
      items =
        raw.map { row ->
          row
            .filterValues { it is JsonPrimitive && it != kotlinx.serialization.json.JsonNull }
            .mapValues { (_, value) ->
              kotlinx.serialization.json.Json.decodeFromJsonElement(
                PrototypeScalar.serializer(),
                value,
              )
            } + outer
        },
    )
  }
  val semantics = semantics?.let {
    it.copy(
      label = it.label?.let(instance::display),
      hint = it.hint?.let(instance::display),
    )
  }
  val onAppear = onAppear?.map { it.bound(instance) }
  val onTap = onTap?.map { it.bound(instance) }
  val onLongPress = onLongPress?.map { it.bound(instance) }
  val onDoubleTap = onDoubleTap?.map { it.bound(instance) }
  val styleWhen = styleWhen?.map { PrototypeStyleWhen(it.`when`.bound(instance), it.style) }
  val visibleWhen = visibleWhen?.bound(instance)
  val shared = shared?.let { it.copy(key = instance.interpolate(it.key)) }
  fun List<PrototypeNode>.bound() = if (nested != null) this else map { it.bound(instance) }
  return when (this) {
    is PrototypeBoxNode ->
      copy(
        repeat = resolvedRepeat ?: repeat,
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
        repeat = resolvedRepeat ?: repeat,
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
        repeat = resolvedRepeat ?: repeat,
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
        repeat = resolvedRepeat ?: repeat,
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
        repeat = resolvedRepeat ?: repeat,
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
        repeat = resolvedRepeat ?: repeat,
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
        text = text?.let(instance::display),
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
                instance.outerAlias,
              )
            options.copy(
              onTap = (bound.getValue("linkify") as JsonObject).getValue("onTap") as JsonArray,
            )
          },
        spans =
          spans?.map { span ->
            span.copy(
              text = instance.display(span.text),
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
        text = instance.display(text),
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
        url = url?.let(instance::interpolate),
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
        placeholder = placeholder?.let(instance::display),
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
        errorText = errorText?.let(instance::display),
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
        label = instance.display(label),
        split =
          split?.let { authored ->
            authored.copy(
              menu =
                authored.menu.map { item ->
                  if (item is PrototypeMenuEntry)
                    item.copy(
                      label = instance.display(item.label),
                      trailingText = item.trailingText?.let(instance::display),
                      onTap = item.onTap?.map { it.bound(instance) },
                    )
                  else item
                },
            )
          },
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
        label = label?.let(instance::display),
        options = options.map { it.copy(label = instance.display(it.label)) },
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
                label = instance.display(item.label),
                trailingText = item.trailingText?.let(instance::display),
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
        title = title?.let(instance::display),
        text = text?.let(instance::display),
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
        label = label?.let(instance::display),
        menu =
          menu?.let { authored ->
            authored.copy(
              items =
                authored.items.map {
                  it.copy(
                    label = instance.display(it.label),
                    onTap = it.onTap.map { action -> action.bound(instance) },
                  )
                },
            )
          },
      )
    is PrototypeSegmentedButtonNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        options = options.map { it.copy(label = instance.display(it.label)) },
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
        title = instance.display(title),
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
    is PrototypeWebViewNode ->
      copy(
        semantics = semantics,
        onAppear = onAppear,
        onTap = onTap,
        styleWhen = styleWhen,
        shared = shared,
        visibleWhen = visibleWhen,
        url = instance.interpolate(url),
        onNavigate = onNavigate?.map { it.bound(instance) },
        onBlockedNavigation = onBlockedNavigation?.map { it.bound(instance) },
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
    is PrototypeLoadingIndicatorNode ->
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
        text = instance.display(text),
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
  copy(label = instance.display(label), onTap = onTap?.map { it.bound(instance) })

private fun PrototypeListItemTrailing.bound(instance: RepeatInstance): PrototypeListItemTrailing =
  when (this) {
    is PrototypeListItemSwitch -> copy(stateKey = instance.interpolate(stateKey))
    is PrototypeListItemCheckbox -> copy(stateKey = instance.interpolate(stateKey))
    else -> this
  }

private fun PrototypeSwipeActions.bound(instance: RepeatInstance) =
  copy(start = start?.map { it.bound(instance) }, end = end?.map { it.bound(instance) })

private fun PrototypeSwipeAction.bound(instance: RepeatInstance) =
  copy(label = instance.display(label), onTap = onTap.map { it.bound(instance) })

private fun PrototypeAppBarAction.bound(instance: RepeatInstance) =
  copy(label = instance.display(label), onTap = onTap?.map { it.bound(instance) })

private fun PrototypeRequestAction.boundRequest(instance: RepeatInstance): PrototypeRequestAction {
  val where = where
  return copy(
    url = instance.interpolate(url),
    headers = headers?.mapValues { (_, entry) -> instance.requestEntry(entry) },
    query = query?.mapValues { (_, entry) -> instance.requestEntry(entry) },
    body = body?.let(instance::dataValue),
    into = into?.let(instance::dataPath),
    where = where?.boundWhere(instance),
    append = append?.let { it.copy(to = instance.dataPath(it.to)) },
    statusKey = statusKey?.let(instance::interpolate),
    onSuccess = onSuccess?.map { it.bound(instance) },
    onError = onError?.map { it.bound(instance) },
  )
}

/**
 * Mirrors the protocol binder's `platform` (#14294): argument bindings, `into`, `statusKey` and the
 * follow-ups bind to the row; literal arguments pass through.
 */
private fun PrototypePlatformAction.boundPlatform(instance: RepeatInstance) =
  copy(
    args =
      args?.mapValues { (_, value) -> (value as? JsonObject)?.let(instance::dataValue) ?: value },
    into = into?.let(instance::dataPath),
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
              instance.outerAlias,
            )
          },
      )
    is PrototypeStartTimerAction -> copy(actions = actions.map { it.bound(instance) })
    is PrototypeCancelTimerAction -> this
    is PrototypeRequestAction -> boundRequest(instance)
    is PrototypePlatformAction -> boundPlatform(instance)
    is PrototypeToggleAction -> copy(key = instance.interpolate(key))
    is PrototypeIncrementAction -> copy(key = instance.interpolate(key))
    is PrototypeDecrementAction -> copy(key = instance.interpolate(key))
    else -> boundDataAction(instance) ?: boundRouteAction(instance) ?: this
  }

private fun PrototypeAction.boundRouteAction(instance: RepeatInstance): PrototypeAction? =
  when (this) {
    is PrototypePushAction -> copy(params = params?.let(instance::routeParams))
    is PrototypeReplaceAction -> copy(params = params?.let(instance::routeParams))
    is PrototypeSetStackAction ->
      copy(path = path.map { it.copy(params = it.params?.let(instance::routeParams)) })
    else -> null
  }

/**
 * Navigation params of a row (#14188): a binding binds like a data value, a literal string that is
 * one placeholder keeps the item's type and any other literal renders to text.
 */
private fun RepeatInstance.routeParams(params: Map<String, JsonElement>): Map<String, JsonElement> =
  params.mapValues { (_, value) ->
    when {
      value is JsonObject -> dataValue(value)
      value is JsonPrimitive && value.isString ->
        EmitContextResolver.scalar(interpolateTyped(value.content))
      else -> value
    }
  }

private fun PrototypeAction.boundDataAction(instance: RepeatInstance): PrototypeAction? =
  when (this) {
    is PrototypeSetDataAction ->
      copy(
        path = instance.dataPath(path),
        value = instance.dataActionValue(value),
        where = where?.boundWhere(instance),
      )
    is PrototypePrependDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataActionValue(value))
    is PrototypeAppendDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataActionValue(value))
    is PrototypeUpsertDataAction ->
      copy(path = instance.dataPath(path), value = instance.dataActionValue(value))
    is PrototypeRemoveDataAction ->
      copy(path = instance.dataPath(path), where = where?.boundWhere(instance))
    else -> null
  }

/** A keyed selector binds `{item}` / `{index}` like a request's `where`. */
private fun PrototypeDataWhere.boundWhere(instance: RepeatInstance) =
  copy(equals = instance.dataValue(equals))

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
    outerAlias,
  )

/** A data action's value: an `{object}` (#18826) binds each member like [dataValue]. */
private fun RepeatInstance.dataActionValue(binding: EmitContextBinding): EmitContextBinding =
  PrototypeObjectDataValue.bindToRow(
    binding,
    alias,
    item.mapValues { (_, value) -> EmitContextResolver.scalar(value) },
    index,
  )

private fun PrototypeCondition.bound(instance: RepeatInstance): PrototypeCondition =
  copy(
    valid = valid?.let { PrototypeValidityKeys.Multiple(it.keys().map(instance::interpolate)) },
    key = key?.let(instance::interpolate),
    equalsKey = equalsKey?.let(instance::interpolate),
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
  val only = PrototypeRepeatTemplate.segments(text, alias, outerAlias).singleOrNull()
  val typed =
    when (only) {
      is PrototypeRepeatSegment.Index -> PrototypeScalar.Numeric(index.toDouble())
      is PrototypeRepeatSegment.Field -> item[only.name]
      else -> null
    }
  return typed ?: PrototypeScalar.Text(interpolate(text))
}

/**
 * Display text: like [interpolate], but each inserted item value is shielded so the later state,
 * derived and data passes keep it literal (#18628).
 */
private fun RepeatInstance.display(text: String): String =
  PrototypeRepeatTemplate.segments(text, alias, outerAlias).joinToString("") { segment ->
    when (segment) {
      is PrototypeRepeatSegment.Literal -> segment.text
      is PrototypeRepeatSegment.Index -> index.toString()
      is PrototypeRepeatSegment.Field ->
        item[segment.name]?.renderedText()?.let(PrototypeTextShield::shield)
          ?: "{$alias.${segment.name}}"
    }
  }

/** Unknown fields cannot occur after validation; they are left as their literal placeholder. */
private fun RepeatInstance.interpolate(text: String): String =
  PrototypeRepeatTemplate.segments(text, alias, outerAlias).joinToString("") { segment ->
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
        item
          .filterValues { it is JsonPrimitive }
          .mapValues { (_, value) ->
            kotlinx.serialization.json.Json.decodeFromJsonElement(
              PrototypeScalar.serializer(),
              value,
            )
          }
          .mapValues { (_, value) -> shieldPrototypeRowScalar(value) },
        index,
        source = item,
      ),
    )

private const val ROW_SHIELD = '\uE000'

/**
 * Row values are bound before the lazy row's data text resolves, so a literal `{data:` or
 * `{platform:` inside one must not be scanned as an authored placeholder. The marker is removed by
 * [unshieldPrototypeRowText] once the node's own text has resolved.
 */
private fun shieldPrototypeRowScalar(scalar: PrototypeScalar): PrototypeScalar =
  if (scalar is PrototypeScalar.Text)
    PrototypeScalar.Text(
      scalar.value
        .replace("{data:", "{${ROW_SHIELD}data:")
        .replace("{platform:", "{${ROW_SHIELD}platform:"),
    )
  else scalar

internal fun unshieldPrototypeRowText(text: String): String = text.replace("{$ROW_SHIELD", "{")
