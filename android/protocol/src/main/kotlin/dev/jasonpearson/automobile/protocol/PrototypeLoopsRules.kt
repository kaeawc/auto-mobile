package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Attention loops must return to the identity transform, including conditional styles. */
internal object PrototypeLoopsRules {
  fun validate(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      val effect = (node["loop"] as? JsonObject)?.text("effect") ?: continue
      val field = if (effect == "pulse") "scale" else "rotation"
      val styles =
        listOf(node["style"]) +
          (node["styleWhen"] as? JsonArray).orEmpty().map { (it as? JsonObject)?.get("style") }
      if (styles.any { (it as? JsonObject)?.containsKey(field) == true })
        return fail("$path.loop", "$effect loop cannot set style.$field")
    }
    return null
  }
}
