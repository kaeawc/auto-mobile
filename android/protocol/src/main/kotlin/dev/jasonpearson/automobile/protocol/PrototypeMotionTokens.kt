package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The canonical physical spring, loaded from the packaged structural contract. */
data class PrototypeMotionToken(val dampingRatio: Double, val stiffness: Double)

object PrototypeMotionTokens {
  fun role(property: String): String =
    if (property in setOf("alpha", "background", "color", "border.color")) "effects" else "spatial"

  fun token(
    scheme: String = "standard",
    role: String = "spatial",
    tempo: String = "default",
  ): PrototypeMotionToken {
    val value =
      PrototypeSpecContract.motionTokens
        .getValue(scheme)
        .jsonObject
        .getValue(role)
        .jsonObject
        .getValue(tempo)
        .jsonObject
    return PrototypeMotionToken(
      value.getValue("dampingRatio").jsonPrimitive.double,
      value.getValue("stiffness").jsonPrimitive.double,
    )
  }

  internal fun animateError(data: JsonObject, path: String): PrototypeSpecError? =
    if ("tempo" in data && listOf("durationMs", "easing").any { it in data })
      PrototypeSpecError("$path.tempo", "tempo cannot be combined with durationMs or easing")
    else null
}
