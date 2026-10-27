package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

internal object PrototypeKeyframesRules {
  fun validate(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    val spec = context.root as? JsonObject ?: return null
    val state = spec["state"] as? JsonObject
    val data = spec["data"] as? JsonObject
    for ((node, path) in context.nodes) {
      val frames = node["keyframes"] as? JsonObject ?: continue
      val trigger = frames["trigger"] as JsonObject
      val key = trigger.text("key")
      if (key != null && state?.containsKey(key) != true)
        return fail("$path.keyframes.trigger.key", "Unknown state key")
      val pointer = trigger.text("data")
      if (pointer != null && PrototypeDataPointer.resolve(data, pointer) == null)
        return fail("$path.keyframes.trigger.data", "Data pointer does not resolve")
      for ((name, track) in frames["tracks"] as JsonObject) {
        val points = prototypeKeyframePoints(track)
        val at = "$path.keyframes.tracks.$name"
        val rest = if (name.startsWith("scale") || name == "alpha") 1.0 else 0.0
        if (
          points.first().first != 0.0 ||
            points.last().first != 1.0 ||
            points.zipWithNext().any { (a, b) -> a.first >= b.first } ||
            points.any { it.first !in 0.0..1.0 }
        )
          return fail(at, "Fractions must increase strictly from 0 to 1")
        if (points.first().second != rest || points.last().second != rest)
          return fail(at, "First and last values must equal rest value ${rest.toInt()}")
        if (
          points.any { (_, v) ->
            if (name == "alpha") v !in 0.0..1.0 else name.startsWith("scale") && v <= 0
          }
        )
          return fail(at, "alpha must be in 0..1 and scale values must be positive")
      }
    }
    return null
  }
}
