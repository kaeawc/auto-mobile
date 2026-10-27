// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PrototypeShadowOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class PrototypeShadow(
  val color: PrototypeModeValue,
  val radius: Double,
  val spread: Double? = null,
  val offset: PrototypeShadowOffset? = null,
  val inner: Boolean? = null,
)

@Serializable
data class PrototypeFadeEdges(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class PrototypeImageFilter(
  val saturation: Double? = null,
  val tint: PrototypeModeValue? = null,
)

/** Tooltip spotlight hole: padding 0..64 dp (default 8), cornerRadius 0..64 dp (default 12). */
@Serializable
data class PrototypeTooltipSpotlight(
  val padding: Int? = null,
  val cornerRadius: Int? = null,
)

@Serializable
data class PrototypeOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class PrototypePadding(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class PrototypeBounds(
  val x: Double,
  val y: Double,
  val width: Double,
  val height: Double,
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

/** A node's style animation (#14208): `durationMs` 0..2000 (default 300) and `easing`. */
@Serializable
data class PrototypeAnimate(
  val durationMs: Int? = null,
  val easing: String? = null,
)

/** Container `stagger` (#15247): each `visibleWhen` child enters `ms` after the previous one. */
@Serializable
data class PrototypeStagger(
  val ms: Int,
  val order: String? = null,
)

/** An image's zoom range: 1 up to `maxScale` (1..8). */
@Serializable
data class PrototypeZoomable(
  val maxScale: Double,
)

@Serializable
data class PrototypeRadioOption(
  val value: String,
  val label: String,
)

/** A fixed y axis for a chart; `max` is above `min`. */
@Serializable
data class PrototypeChartRange(
  val min: Double,
  val max: Double,
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
data class PrototypeStyleWhen(
  val `when`: PrototypeCondition,
  val style: PrototypeStyle,
)

/** An icon-only control in a `topAppBar`: the icon, its accessible label and its tap. */
@Serializable
data class PrototypeAppBarAction(
  val icon: String,
  val label: String,
  val onTap: List<PrototypeAction>? = null,
)

/** A `dialog` or `snackbar` button: a tap closes its container, then runs `onTap`. */
@Serializable
data class PrototypeDialogButton(
  val label: String,
  val onTap: List<PrototypeAction>? = null,
)

/**
 * Pull-to-refresh on a vertical [PrototypeScrollNode]: the indicator shows while the boolean state
 * [stateKey] is true. A pull writes true to it and runs [onRefresh]; the prototype or a patch
 * writes false to end it.
 */
@Serializable
data class PrototypeScrollRefresh(
  val stateKey: String,
  val onRefresh: List<PrototypeAction>,
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
data class PrototypeFullscreenPlacement(
  val scrim: PrototypeModeValue? = null,
) : PrototypePlacement()

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
