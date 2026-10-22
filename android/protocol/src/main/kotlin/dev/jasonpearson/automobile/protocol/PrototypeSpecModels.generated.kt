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
