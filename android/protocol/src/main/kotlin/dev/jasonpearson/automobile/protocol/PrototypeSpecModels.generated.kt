// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
package dev.jasonpearson.automobile.protocol

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
