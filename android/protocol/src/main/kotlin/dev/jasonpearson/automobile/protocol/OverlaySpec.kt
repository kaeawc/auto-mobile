package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class OverlayOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class OverlayBounds(
  val x: Double,
  val y: Double,
  val width: Double,
  val height: Double,
)

@Serializable
data class OverlayContainer(
  val elementId: String? = null,
  val text: String? = null,
  val index: Int? = null,
  val selectionStrategy: String? = null,
  val container: OverlayContainer? = null,
)

@Serializable
data class OverlaySelector(
  val elementId: String? = null,
  val text: String? = null,
  val testTag: String? = null,
  val container: OverlayContainer? = null,
)

@Serializable
data class OverlayCondition(
  val key: String? = null,
  val equals: OverlayScalar? = null,
  val notEquals: OverlayScalar? = null,
  val gt: Double? = null,
  val lt: Double? = null,
  val all: List<OverlayCondition>? = null,
  val any: List<OverlayCondition>? = null,
  val not: OverlayCondition? = null,
)

@Serializable
data class OverlaySheetCondition(
  val key: String,
  val equals: Boolean,
)

@Serializable
data class OverlaySafeAreaPadding(
  val edges: List<String>,
  val types: List<String>,
)

@Serializable
data class OverlayPadding(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class OverlayBorder(
  val width: Double,
  val color: String,
)

@Serializable
data class OverlayGradientStop(
  val color: String,
  val position: Double? = null,
)

@Serializable sealed class OverlayGradient

@SerialName("linear")
@Serializable
data class OverlayLinearGradient(
  val angle: Double,
  val stops: List<OverlayGradientStop>,
) : OverlayGradient()

@SerialName("radial")
@Serializable
data class OverlayRadialGradient(val stops: List<OverlayGradientStop>) : OverlayGradient()

@Serializable
data class OverlayStyle(
  val width: OverlayDimension? = null,
  val height: OverlayDimension? = null,
  val weight: Double? = null,
  val minWidth: Double? = null,
  val maxWidth: Double? = null,
  val minHeight: Double? = null,
  val maxHeight: Double? = null,
  val padding: OverlayPadding? = null,
  val background: String? = null,
  /** A dp number or a Material Shapes token. */
  val cornerRadius: OverlayCornerRadius? = null,
  val border: OverlayBorder? = null,
  val elevation: Double? = null,
  val gradient: OverlayGradient? = null,
  val aspectRatio: Double? = null,
  val alpha: Double? = null,
  val alignment: String? = null,
  val arrangement: String? = null,
  val spacing: Double? = null,
  val textSize: Double? = null,
  val fontWeight: Int? = null,
  val color: String? = null,
  val textAlign: String? = null,
  val maxLines: Int? = null,
  val fontFamily: OverlayFontFamily? = null,
  /** A Material 3 type role (`titleLarge`, ...); explicit size, weight and family still win. */
  val textStyle: String? = null,
)

/**
 * A literal list template: the container's children are instantiated once per [items] entry, with
 * `{as.field}` and `{index}` bound per instance. Each item maps field names to scalar values.
 */
@Serializable
data class OverlayRepeat(val items: List<Map<String, OverlayScalar>>, val `as`: String)

@Serializable data class OverlayStyleWhen(val `when`: OverlayCondition, val style: OverlayStyle)

@Serializable
data class OverlayItem(
  val label: String,
  val icon: String? = null,
  val image: String? = null,
)

@Serializable sealed class OverlayAnchor

@SerialName("bounds")
@Serializable
data class OverlayBoundsAnchor(val bounds: OverlayBounds) : OverlayAnchor()

@SerialName("element")
@Serializable
data class OverlayElementAnchor(
  val selector: OverlaySelector,
  val alignment: String,
  val offset: OverlayOffset? = null,
) : OverlayAnchor()

@Serializable sealed class OverlayPlacement

@SerialName("fullscreen")
@Serializable
data class OverlayFullscreenPlacement(val scrim: String? = null) : OverlayPlacement()

@SerialName("sheet")
@Serializable
data class OverlaySheetPlacement(
  val edge: String,
  val height: Double,
) : OverlayPlacement()

@SerialName("floating")
@Serializable
data class OverlayFloatingPlacement(
  val gravity: String,
  val offset: OverlayOffset,
) : OverlayPlacement()

@Serializable sealed class OverlayAction

@SerialName("emit")
@Serializable
data class OverlayEmitAction(
  val name: String,
  val payload: JsonElement? = null,
) : OverlayAction()

@SerialName("setPage")
@Serializable
data class OverlaySetPageAction(
  val pager: String,
  val page: OverlayPageTarget,
) : OverlayAction()

@SerialName("setState")
@Serializable
data class OverlaySetStateAction(
  val key: String,
  val value: OverlayScalar,
) : OverlayAction()

@SerialName("toggle")
@Serializable
data class OverlayToggleAction(val key: String) : OverlayAction()

@SerialName("increment")
@Serializable
data class OverlayIncrementAction(val key: String, val by: Double? = null) : OverlayAction()

@SerialName("decrement")
@Serializable
data class OverlayDecrementAction(val key: String, val by: Double? = null) : OverlayAction()

@SerialName("dismiss") @Serializable data object OverlayDismissAction : OverlayAction()

@Serializable
sealed class OverlayNode {
  abstract val id: String?
  abstract val testTag: String?
  abstract val onTap: List<OverlayAction>?
  abstract val style: OverlayStyle?
  abstract val styleWhen: List<OverlayStyleWhen>?
  abstract val visibleWhen: OverlayCondition?
  /** `none`, `fade`, `expand` or `slide`: the `visibleWhen` enter/exit; absent is fade + expand. */
  abstract val transition: String?
  abstract val anchor: OverlayAnchor?
  abstract val safeAreaPadding: OverlaySafeAreaPadding?
}

@SerialName("box")
@Serializable
data class OverlayBoxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
  val repeat: OverlayRepeat? = null,
) : OverlayNode()

@SerialName("row")
@Serializable
data class OverlayRowNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
  val repeat: OverlayRepeat? = null,
) : OverlayNode()

@SerialName("column")
@Serializable
data class OverlayColumnNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
  val repeat: OverlayRepeat? = null,
) : OverlayNode()

@SerialName("text")
@Serializable
data class OverlayTextNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val text: String,
) : OverlayNode()

@SerialName("image")
@Serializable
data class OverlayImageNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val asset: String,
  val contentScale: String = "fit",
) : OverlayNode()

@SerialName("icon")
@Serializable
data class OverlayIconNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val name: String,
  /** One of filled (default), outlined, rounded, sharp, twoTone; closed by the contract. */
  val variant: String? = null,
) : OverlayNode()

@SerialName("spacer")
@Serializable
data class OverlaySpacerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
) : OverlayNode()

@SerialName("textField")
@Serializable
data class OverlayTextFieldNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val placeholder: String? = null,
) : OverlayNode()

@SerialName("switch")
@Serializable
data class OverlaySwitchNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
) : OverlayNode()

@SerialName("checkbox")
@Serializable
data class OverlayCheckboxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
) : OverlayNode()

@SerialName("button")
@Serializable
data class OverlayButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val label: String,
  val variant: String = "filled",
  val icon: String? = null,
) : OverlayNode()

@Serializable data class OverlayRadioOption(val value: String, val label: String)

@SerialName("radioGroup")
@Serializable
data class OverlayRadioGroupNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val options: List<OverlayRadioOption>,
) : OverlayNode()

/** The control at the end of a `listItem`: a bound switch or checkbox, or a decorative icon. */
@Serializable sealed class OverlayListItemTrailing

@SerialName("switch")
@Serializable
data class OverlayListItemSwitch(val stateKey: String) : OverlayListItemTrailing()

@SerialName("checkbox")
@Serializable
data class OverlayListItemCheckbox(val stateKey: String) : OverlayListItemTrailing()

@SerialName("icon")
@Serializable
data class OverlayListItemIcon(val name: String) : OverlayListItemTrailing()

@SerialName("listItem")
@Serializable
data class OverlayListItemNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val headline: String,
  val supporting: String? = null,
  val leadingIcon: String? = null,
  val trailing: OverlayListItemTrailing? = null,
) : OverlayNode()

@SerialName("slider")
@Serializable
data class OverlaySliderNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val label: String? = null,
  val min: Double,
  val max: Double,
  val step: Double? = null,
) : OverlayNode()

@SerialName("chip")
@Serializable
data class OverlayChipNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val label: String,
  val variant: String? = null,
  val stateKey: String? = null,
) : OverlayNode()

@SerialName("card")
@Serializable
data class OverlayCardNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val variant: String = "filled",
  val children: List<OverlayNode>,
) : OverlayNode()

@SerialName("scroll")
@Serializable
data class OverlayScrollNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val axis: String = "vertical",
  val child: OverlayNode,
) : OverlayNode()

@SerialName("pager")
@Serializable
data class OverlayPagerNode(
  override val id: String,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
) : OverlayNode()

@SerialName("tabBar")
@Serializable
data class OverlayTabBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val items: List<OverlayItem>,
  val pager: String? = null,
  val stateKey: String? = null,
  val scrollable: Boolean = false,
) : OverlayNode()

@SerialName("bottomNav")
@Serializable
data class OverlayBottomNavNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val items: List<OverlayItem>,
  val pager: String? = null,
  val stateKey: String? = null,
) : OverlayNode()

@SerialName("bottomSheet")
@Serializable
data class OverlayBottomSheetNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val styleWhen: List<OverlayStyleWhen>? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val child: OverlayNode,
  val openWhen: OverlaySheetCondition,
  val detents: List<OverlayDetent>,
  val scrim: String? = null,
  val dragHandle: Boolean = true,
  val dismissOnSwipe: Boolean = true,
) : OverlayNode()

@Serializable
data class OverlayWindow(
  val placement: OverlayPlacement,
  val opacity: Int = 100,
  /**
   * `system` (default when absent) stacks above system UI as an accessibility overlay; `app` stacks
   * just above apps, below the shade, keyboard and screenshot preview, and needs
   * SYSTEM_ALERT_WINDOW.
   */
  val layer: String? = null,
  /**
   * `session` (default when absent) ends the overlay with its host session; `device` keeps it
   * interactive after the last client disconnects and disables the idle timeout.
   */
  val persistence: String? = null,
)

/**
 * `source = "device"` asks for Android 12+ dynamic colour; `seed` generates a scheme from one
 * colour.
 */
@Serializable
data class OverlaySpecThemeColors(
  val seed: String? = null,
  val source: String? = null,
)

/** `scale` multiplies every Material type role; `fontFamily` is sans, serif or mono. */
@Serializable
data class OverlaySpecThemeTypography(
  val scale: Double? = null,
  val fontFamily: String? = null,
)

/** `corner` picks one of the Material corner families (none, small, medium, large, full). */
@Serializable data class OverlaySpecThemeShapes(val corner: String? = null)

@Serializable
data class OverlaySpecTheme(
  val mode: String? = null,
  val colors: OverlaySpecThemeColors? = null,
  val typography: OverlaySpecThemeTypography? = null,
  val shapes: OverlaySpecThemeShapes? = null,
)

@Serializable
data class OverlaySpec(
  val id: String,
  val window: OverlayWindow,
  val state: Map<String, OverlayScalar>? = null,
  val root: OverlayNode,
  val theme: OverlaySpecTheme? = null,
  /** `none` opts out of overlay animation; absent or `standard` follows the system scale. */
  val motion: String? = null,
)
