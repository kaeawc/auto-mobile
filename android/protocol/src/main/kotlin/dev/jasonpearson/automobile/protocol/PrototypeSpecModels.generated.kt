// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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

/** One gradient stop: a colour slot and an optional position in 0...1. */
@Serializable
data class PrototypeGradientStop(
  val color: PrototypeModeValue,
  val position: Double? = null,
) {
  constructor(
    color: String,
    position: Double? = null,
  ) : this(PrototypeModeValue.Single(color), position)
}

@Serializable
data class PrototypeBorder(
  val width: Double,
  val color: PrototypeModeValue,
) {
  constructor(width: Double, color: String) : this(width, PrototypeModeValue.Single(color))
}

@Serializable
data class PrototypeItem(
  val label: String,
  val icon: String? = null,
  /** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
  val image: PrototypeModeValue? = null,
) {
  constructor(
    label: String,
    icon: String? = null,
    image: String,
  ) : this(label, icon, PrototypeModeValue.Single(image))
}

@Serializable
data class PrototypeCondition(
  val key: String? = null,
  val equals: PrototypeScalar? = null,
  val notEquals: PrototypeScalar? = null,
  val gt: Double? = null,
  val lt: Double? = null,
  /** With [data]: holds when that value is missing, `[]`, `{}` or `""` (#14207). */
  val empty: Boolean? = null,
  val all: List<PrototypeCondition>? = null,
  val any: List<PrototypeCondition>? = null,
  val not: PrototypeCondition? = null,
  val data: String? = null,
  val valid: PrototypeValidityKeys? = null,
  /** A `/platform` pointer (#14294); platform state is device-owned and read-only. */
  val platform: String? = null,
)

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
  /** Hex, colour role, or a `{light, dark}` pair of either, as every colour slot (#11218). */
  val background: PrototypeModeValue? = null,
  /** A dp number, a Material Shapes token, or per-corner dp radii. */
  val cornerRadius: PrototypeCornerRadius? = null,
  val border: PrototypeBorder? = null,
  val elevation: Double? = null,
  /** Hex or colour role tinting the `elevation` shadow; absent keeps the platform shadow colour. */
  val shadowColor: PrototypeModeValue? = null,
  val gradient: PrototypeGradient? = null,
  val aspectRatio: Double? = null,
  /** A dp draw offset; it moves the drawn and touchable node without changing its layout slot. */
  val offset: PrototypeOffset? = null,
  val alpha: Double? = null,
  /** Scale (0.5-1) a tappable node shrinks to while pressed; absent leaves it unscaled. */
  val pressScale: Double? = null,
  /** An animated highlight sweep over a loading placeholder's background (#14207). */
  val shimmer: Boolean? = null,
  val alignment: String? = null,
  val arrangement: String? = null,
  val spacing: Double? = null,
  val runSpacing: Double? = null,
  val textSize: Double? = null,
  val fontWeight: Int? = null,
  val color: PrototypeModeValue? = null,
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
  /** A drawn scale (0-4) about the node's centre; absent is 1 (#14208). */
  val scale: Double? = null,
  /** A drawn rotation in degrees (-360..360) about the node's centre (#14208). */
  val rotation: Double? = null,
)
