package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class PrototypeOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class PrototypeBounds(
  val x: Double,
  val y: Double,
  val width: Double,
  val height: Double,
)

@Serializable
data class PrototypeContainer(
  val elementId: String? = null,
  val text: String? = null,
  val index: Int? = null,
  val selectionStrategy: String? = null,
  val container: PrototypeContainer? = null,
)

@Serializable
data class PrototypeSelector(
  val elementId: String? = null,
  val text: String? = null,
  val testTag: String? = null,
  val container: PrototypeContainer? = null,
)

@Serializable
data class PrototypeCondition(
  val key: String? = null,
  val equals: PrototypeScalar? = null,
  val notEquals: PrototypeScalar? = null,
  val gt: Double? = null,
  val lt: Double? = null,
  val all: List<PrototypeCondition>? = null,
  val any: List<PrototypeCondition>? = null,
  val not: PrototypeCondition? = null,
)

@Serializable
data class PrototypeSheetCondition(
  val key: String,
  val equals: Boolean,
)

@Serializable
data class PrototypeSafeAreaPadding(
  val edges: List<String>,
  val types: List<String>,
)

@Serializable
data class PrototypePadding(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class PrototypeBorder(
  val width: Double,
  val color: String,
)

@Serializable
data class PrototypeGradientStop(
  val color: String,
  val position: Double? = null,
)

@Serializable sealed class PrototypeGradient

@SerialName("linear")
@Serializable
data class PrototypeLinearGradient(
  val angle: Double,
  val stops: List<PrototypeGradientStop>,
) : PrototypeGradient()

@SerialName("radial")
@Serializable
data class PrototypeRadialGradient(val stops: List<PrototypeGradientStop>) : PrototypeGradient()

@Serializable
data class PrototypeStyle(
  val width: PrototypeDimension? = null,
  val height: PrototypeDimension? = null,
  val weight: Double? = null,
  val minWidth: Double? = null,
  val maxWidth: Double? = null,
  val minHeight: Double? = null,
  val maxHeight: Double? = null,
  val padding: PrototypePadding? = null,
  val background: String? = null,
  /** A dp number, a Material Shapes token, or per-corner dp radii. */
  val cornerRadius: PrototypeCornerRadius? = null,
  val border: PrototypeBorder? = null,
  val elevation: Double? = null,
  /** Hex or colour role tinting the `elevation` shadow; absent keeps the platform shadow colour. */
  val shadowColor: String? = null,
  val gradient: PrototypeGradient? = null,
  val aspectRatio: Double? = null,
  /** A dp draw offset; it moves the drawn and touchable node without changing its layout slot. */
  val offset: PrototypeOffset? = null,
  val alpha: Double? = null,
  /** Scale (0.5-1) a tappable node shrinks to while pressed; absent leaves it unscaled. */
  val pressScale: Double? = null,
  val alignment: String? = null,
  val arrangement: String? = null,
  val spacing: Double? = null,
  val textSize: Double? = null,
  val fontWeight: Int? = null,
  val color: String? = null,
  val textAlign: String? = null,
  val maxLines: Int? = null,
  /** Positive sp between baselines. */
  val lineHeight: Double? = null,
  /** sp added between letters; negative tightens. */
  val letterSpacing: Double? = null,
  /** `none`, `underline`, `lineThrough` or `underlineLineThrough`. */
  val textDecoration: String? = null,
  /** `normal` or `italic`. */
  val fontStyle: String? = null,
  /** How text past `maxLines` or its width ends: `clip` (default), `ellipsis` or `visible`. */
  val overflow: String? = null,
  val fontFamily: PrototypeFontFamily? = null,
  /** A Material 3 type role (`titleLarge`, ...); explicit size, weight and family still win. */
  val textStyle: String? = null,
)

/**
 * A literal list template: the container's children are instantiated once per [items] entry, with
 * `{as.field}` and `{index}` bound per instance. Each item maps field names to scalar values.
 */
@Serializable
data class PrototypeRepeat(val items: List<Map<String, PrototypeScalar>>, val `as`: String)

@Serializable
data class PrototypeStyleWhen(val `when`: PrototypeCondition, val style: PrototypeStyle)

@Serializable
data class PrototypeItem(
  val label: String,
  val icon: String? = null,
  val image: String? = null,
)

@Serializable sealed class PrototypeAnchor

/**
 * Screen-space dp [bounds]. [alignment] (`cover` when absent) lays the node over them or along one
 * of their edges, then [offset] shifts it. The host resolves an element anchor into this shape, so
 * it is the only anchor the renderer lays out (#9316).
 */
@SerialName("bounds")
@Serializable
data class PrototypeBoundsAnchor(
  val bounds: PrototypeBounds,
  val alignment: String? = null,
  val offset: PrototypeOffset? = null,
) : PrototypeAnchor()

@SerialName("element")
@Serializable
data class PrototypeElementAnchor(
  val selector: PrototypeSelector,
  val alignment: String,
  val offset: PrototypeOffset? = null,
) : PrototypeAnchor()

@Serializable sealed class PrototypePlacement

@SerialName("fullscreen")
@Serializable
data class PrototypeFullscreenPlacement(val scrim: String? = null) : PrototypePlacement()

@SerialName("sheet")
@Serializable
data class PrototypeSheetPlacement(
  val edge: String,
  val height: Double,
) : PrototypePlacement()

@SerialName("floating")
@Serializable
data class PrototypeFloatingPlacement(
  val gravity: String,
  val offset: PrototypeOffset,
) : PrototypePlacement()

@Serializable sealed class PrototypeAction

@SerialName("emit")
@Serializable
data class PrototypeEmitAction(
  val name: String,
  val payload: JsonElement? = null,
) : PrototypeAction()

@SerialName("setPage")
@Serializable
data class PrototypeSetPageAction(
  val pager: String,
  val page: PrototypePageTarget,
) : PrototypeAction()

@SerialName("setState")
@Serializable
data class PrototypeSetStateAction(
  val key: String,
  val value: PrototypeScalar,
) : PrototypeAction()

@SerialName("toggle")
@Serializable
data class PrototypeToggleAction(val key: String) : PrototypeAction()

@SerialName("increment")
@Serializable
data class PrototypeIncrementAction(val key: String, val by: Double? = null) : PrototypeAction()

@SerialName("decrement")
@Serializable
data class PrototypeDecrementAction(val key: String, val by: Double? = null) : PrototypeAction()

@SerialName("dismiss") @Serializable data object PrototypeDismissAction : PrototypeAction()

@Serializable
sealed class PrototypeNode {
  abstract val id: String?
  abstract val testTag: String?
  /** The node's accessible label; replaces the label derived from its text, icon or kind. */
  abstract val contentDescription: String?
  abstract val onTap: List<PrototypeAction>?
  abstract val style: PrototypeStyle?
  abstract val styleWhen: List<PrototypeStyleWhen>?
  abstract val visibleWhen: PrototypeCondition?
  /** `none`, `fade`, `expand` or `slide`: the `visibleWhen` enter/exit; absent is fade + expand. */
  abstract val transition: String?
  abstract val anchor: PrototypeAnchor?
  abstract val safeAreaPadding: PrototypeSafeAreaPadding?
}

@SerialName("box")
@Serializable
data class PrototypeBoxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
) : PrototypeNode()

@SerialName("row")
@Serializable
data class PrototypeRowNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
) : PrototypeNode()

@SerialName("column")
@Serializable
data class PrototypeColumnNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
) : PrototypeNode()

@SerialName("text")
@Serializable
data class PrototypeTextNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val text: String,
) : PrototypeNode()

@SerialName("image")
@Serializable
data class PrototypeImageNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val asset: String,
  val contentScale: String = "fit",
) : PrototypeNode()

@SerialName("icon")
@Serializable
data class PrototypeIconNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val name: String,
  /** One of filled (default), outlined, rounded, sharp, twoTone; closed by the contract. */
  val variant: String? = null,
) : PrototypeNode()

@SerialName("spacer")
@Serializable
data class PrototypeSpacerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
) : PrototypeNode()

@SerialName("textField")
@Serializable
data class PrototypeTextFieldNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val placeholder: String? = null,
) : PrototypeNode()

@SerialName("switch")
@Serializable
data class PrototypeSwitchNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
) : PrototypeNode()

@SerialName("checkbox")
@Serializable
data class PrototypeCheckboxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
) : PrototypeNode()

@SerialName("button")
@Serializable
data class PrototypeButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val label: String,
  val variant: String = "filled",
  val icon: String? = null,
) : PrototypeNode()

@Serializable data class PrototypeRadioOption(val value: String, val label: String)

@SerialName("radioGroup")
@Serializable
data class PrototypeRadioGroupNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
) : PrototypeNode()

/** The control at the end of a `listItem`: a bound switch or checkbox, or a decorative icon. */
@Serializable sealed class PrototypeListItemTrailing

@SerialName("switch")
@Serializable
data class PrototypeListItemSwitch(val stateKey: String) : PrototypeListItemTrailing()

@SerialName("checkbox")
@Serializable
data class PrototypeListItemCheckbox(val stateKey: String) : PrototypeListItemTrailing()

@SerialName("icon")
@Serializable
data class PrototypeListItemIcon(val name: String) : PrototypeListItemTrailing()

@SerialName("listItem")
@Serializable
data class PrototypeListItemNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val headline: String,
  val supporting: String? = null,
  val leadingIcon: String? = null,
  val trailing: PrototypeListItemTrailing? = null,
) : PrototypeNode()

@SerialName("slider")
@Serializable
data class PrototypeSliderNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
  val min: Double,
  val max: Double,
  val step: Double? = null,
) : PrototypeNode()

@SerialName("chip")
@Serializable
data class PrototypeChipNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val label: String,
  val variant: String? = null,
  val stateKey: String? = null,
) : PrototypeNode()

@SerialName("card")
@Serializable
data class PrototypeCardNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val variant: String = "filled",
  val children: List<PrototypeNode>,
) : PrototypeNode()

/** An icon-only control in a `topAppBar`: the icon, its accessible label and its tap. */
@Serializable
data class PrototypeAppBarAction(
  val icon: String,
  val label: String,
  val onTap: List<PrototypeAction>? = null,
)

/** A `dialog` or `snackbar` button: a tap closes its container, then runs [onTap]. */
@Serializable
data class PrototypeDialogButton(val label: String, val onTap: List<PrototypeAction>? = null)

/** An icon-only Material button; `variant` is standard (default), filled, tonal or outlined. */
@SerialName("iconButton")
@Serializable
data class PrototypeIconButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val icon: String,
  val variant: String = "standard",
) : PrototypeNode()

/** A floating action button; a `label` makes it an extended FAB, which has no `size`. */
@SerialName("fab")
@Serializable
data class PrototypeFabNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val icon: String,
  val label: String? = null,
  val size: String = "regular",
) : PrototypeNode()

/** A single-select Material segmented button bound to a string state key, like a `radioGroup`. */
@SerialName("segmentedButton")
@Serializable
data class PrototypeSegmentedButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
) : PrototypeNode()

/** A Material top app bar with a title, an optional navigation icon and up to three actions. */
@SerialName("topAppBar")
@Serializable
data class PrototypeTopAppBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val title: String,
  val variant: String = "small",
  val navigationIcon: PrototypeAppBarAction? = null,
  val actions: List<PrototypeAppBarAction>? = null,
) : PrototypeNode()

/** A Material divider line, horizontal (default) or vertical. */
@SerialName("divider")
@Serializable
data class PrototypeDividerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val orientation: String = "horizontal",
) : PrototypeNode()

/** A Material badge: a small dot, or a short `text` such as a count. */
@SerialName("badge")
@Serializable
data class PrototypeBadgeNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val text: String? = null,
) : PrototypeNode()

/**
 * A Material progress indicator, linear (default) or circular: determinate over 0..[max] when bound
 * to a number, indeterminate otherwise.
 */
@SerialName("progress")
@Serializable
data class PrototypeProgressNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val variant: String = "linear",
  val stateKey: String? = null,
  val max: Double? = null,
) : PrototypeNode()

/**
 * A Material alert dialog, open while [openWhen] holds. Its buttons and scrim close it by writing
 * the opposite boolean; [child] is optional custom content between the text and the buttons.
 */
@SerialName("dialog")
@Serializable
data class PrototypeDialogNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val openWhen: PrototypeSheetCondition,
  val title: String? = null,
  val text: String? = null,
  val icon: String? = null,
  val confirm: PrototypeDialogButton,
  val dismiss: PrototypeDialogButton? = null,
  val child: PrototypeNode? = null,
) : PrototypeNode()

/**
 * A Material snackbar at the bottom of the window, shown while [openWhen] holds. Without
 * [durationMs] it stays until its action closes it or the state changes; with it, it closes itself
 * by writing the opposite boolean once it has been open that long (a wall-clock timer).
 */
@SerialName("snackbar")
@Serializable
data class PrototypeSnackbarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val openWhen: PrototypeSheetCondition,
  val text: String,
  val action: PrototypeDialogButton? = null,
  val durationMs: Int? = null,
) : PrototypeNode()

/** A Material time picker bound to integer hour (0..23) and minute (0..59) state keys. */
@SerialName("timePicker")
@Serializable
data class PrototypeTimePickerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val hourKey: String,
  val minuteKey: String,
  val is24Hour: Boolean? = null,
) : PrototypeNode()

/** A Material date picker bound to a `YYYY-MM-DD` string state key. */
@SerialName("datePicker")
@Serializable
data class PrototypeDatePickerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
) : PrototypeNode()

@SerialName("scroll")
@Serializable
data class PrototypeScrollNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val axis: String = "vertical",
  val child: PrototypeNode,
) : PrototypeNode()

@SerialName("pager")
@Serializable
data class PrototypePagerNode(
  override val id: String,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val children: List<PrototypeNode>,
) : PrototypeNode()

@SerialName("tabBar")
@Serializable
data class PrototypeTabBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
  val scrollable: Boolean = false,
) : PrototypeNode()

@SerialName("bottomNav")
@Serializable
data class PrototypeBottomNavNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
) : PrototypeNode()

@SerialName("bottomSheet")
@Serializable
data class PrototypeBottomSheetNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: String? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val child: PrototypeNode,
  val openWhen: PrototypeSheetCondition,
  val detents: List<PrototypeDetent>,
  val scrim: String? = null,
  val dragHandle: Boolean = true,
  val dismissOnSwipe: Boolean = true,
) : PrototypeNode()

@Serializable
data class PrototypeWindow(
  val placement: PrototypePlacement,
  val opacity: Int = 100,
  /**
   * `system` (default when absent) stacks above system UI as an accessibility overlay; `app` stacks
   * just above apps, below the shade, keyboard and screenshot preview, and needs
   * SYSTEM_ALERT_WINDOW.
   */
  val layer: String? = null,
  /**
   * `session` (default when absent) ends the prototype with its host session; `device` keeps it
   * interactive after the last client disconnects and disables the idle timeout.
   */
  val persistence: String? = null,
)

/**
 * `source = "device"` asks for Android 12+ dynamic colour; `seed` generates a scheme from one
 * colour. Each Material 3 role field is an explicit hex override applied over that scheme (or the
 * baseline one) in both light and dark.
 */
@Serializable
data class PrototypeSpecThemeColors(
  val seed: String? = null,
  val source: String? = null,
  val primary: String? = null,
  val onPrimary: String? = null,
  val primaryContainer: String? = null,
  val onPrimaryContainer: String? = null,
  val inversePrimary: String? = null,
  val secondary: String? = null,
  val onSecondary: String? = null,
  val secondaryContainer: String? = null,
  val onSecondaryContainer: String? = null,
  val tertiary: String? = null,
  val onTertiary: String? = null,
  val tertiaryContainer: String? = null,
  val onTertiaryContainer: String? = null,
  val background: String? = null,
  val onBackground: String? = null,
  val surface: String? = null,
  val onSurface: String? = null,
  val surfaceVariant: String? = null,
  val onSurfaceVariant: String? = null,
  val surfaceTint: String? = null,
  val inverseSurface: String? = null,
  val inverseOnSurface: String? = null,
  val error: String? = null,
  val onError: String? = null,
  val errorContainer: String? = null,
  val onErrorContainer: String? = null,
  val outline: String? = null,
  val outlineVariant: String? = null,
  val scrim: String? = null,
  val surfaceBright: String? = null,
  val surfaceDim: String? = null,
  val surfaceContainer: String? = null,
  val surfaceContainerHigh: String? = null,
  val surfaceContainerHighest: String? = null,
  val surfaceContainerLow: String? = null,
  val surfaceContainerLowest: String? = null,
)

/** `scale` multiplies every Material type role; `fontFamily` is sans, serif or mono. */
@Serializable
data class PrototypeSpecThemeTypography(
  val scale: Double? = null,
  val fontFamily: String? = null,
)

/** `corner` picks one of the Material corner families (none, small, medium, large, full). */
@Serializable data class PrototypeSpecThemeShapes(val corner: String? = null)

@Serializable
data class PrototypeSpecTheme(
  val mode: String? = null,
  val colors: PrototypeSpecThemeColors? = null,
  val typography: PrototypeSpecThemeTypography? = null,
  val shapes: PrototypeSpecThemeShapes? = null,
)

@Serializable
data class PrototypeSpec(
  val id: String,
  val window: PrototypeWindow,
  val state: Map<String, PrototypeScalar>? = null,
  val root: PrototypeNode,
  val theme: PrototypeSpecTheme? = null,
  /** `none` opts out of prototype animation; absent or `standard` follows the system scale. */
  val motion: String? = null,
)
