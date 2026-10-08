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
data class OverlayStyle(
  val width: OverlayDimension? = null,
  val height: OverlayDimension? = null,
  val padding: OverlayPadding? = null,
  val background: String? = null,
  val cornerRadius: Double? = null,
  val border: OverlayBorder? = null,
  val alpha: Double? = null,
  val alignment: String? = null,
  val arrangement: String? = null,
  val spacing: Double? = null,
  val textSize: Double? = null,
  val fontWeight: Int? = null,
  val color: String? = null,
  val textAlign: String? = null,
  val maxLines: Int? = null,
  val fontFamily: String? = null,
)

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

@SerialName("dismiss") @Serializable data object OverlayDismissAction : OverlayAction()

@Serializable
sealed class OverlayNode {
  abstract val id: String?
  abstract val testTag: String?
  abstract val onTap: List<OverlayAction>?
  abstract val style: OverlayStyle?
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
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
) : OverlayNode()

@SerialName("row")
@Serializable
data class OverlayRowNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
) : OverlayNode()

@SerialName("column")
@Serializable
data class OverlayColumnNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val children: List<OverlayNode>,
) : OverlayNode()

@SerialName("text")
@Serializable
data class OverlayTextNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
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
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val name: String,
) : OverlayNode()

@SerialName("spacer")
@Serializable
data class OverlaySpacerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
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
  override val visibleWhen: OverlayCondition? = null,
  override val transition: String? = null,
  override val anchor: OverlayAnchor? = null,
  override val safeAreaPadding: OverlaySafeAreaPadding? = null,
  val stateKey: String,
  val placeholder: String? = null,
) : OverlayNode()

@SerialName("scroll")
@Serializable
data class OverlayScrollNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val onTap: List<OverlayAction>? = null,
  override val style: OverlayStyle? = null,
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
)

@Serializable
data class OverlaySpec(
  val id: String,
  val window: OverlayWindow,
  val state: Map<String, OverlayScalar>? = null,
  val root: OverlayNode,
  /** `none` opts out of overlay animation; absent or `standard` follows the system scale. */
  val motion: String? = null,
)
