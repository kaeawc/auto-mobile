package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

internal object PrototypeKeyframesRules {
  fun validate(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    val spec = context.root as? JsonObject ?: return null
    val state = spec["state"] as? JsonObject
    val data = spec["data"] as? JsonObject
    // Tracks across all nodes first, in sorted track order, then triggers: the same order the
    // TypeScript and Swift validators report, so a spec with several errors fails identically.
    trackError(context)?.let {
      return it
    }
    for ((node, path) in context.nodes) {
      val frames = node["keyframes"] as? JsonObject ?: continue
      val trigger = frames["trigger"] as JsonObject
      val key = trigger.text("key")
      if (key != null && state?.containsKey(key) != true)
        return fail("$path.keyframes.trigger.key", "Unknown state key")
      val pointer = trigger.text("data")
      if (pointer != null && PrototypeDataPointer.resolve(data, pointer) == null)
        return fail("$path.keyframes.trigger.data", "Data pointer does not resolve")
    }
    return null
  }

  private fun trackError(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      val frames = node["keyframes"] as? JsonObject ?: continue
      for ((name, track) in (frames["tracks"] as JsonObject).toSortedMap()) {
        pointsError(name, prototypeKeyframePoints(track))?.let { (message) ->
          return fail("$path.keyframes.tracks.$name", message)
        }
      }
    }
    return null
  }

  private fun pointsError(name: String, points: List<Pair<Double, Double>>): List<String>? {
    val rest = if (name.startsWith("scale") || name == "alpha") 1.0 else 0.0
    val fractionsBad =
      points.first().first != 0.0 ||
        points.last().first != 1.0 ||
        points.zipWithNext().any { (a, b) -> a.first >= b.first } ||
        points.any { it.first !in 0.0..1.0 }
    val message =
      when {
        fractionsBad -> "Fractions must increase strictly from 0 to 1"
        points.first().second != rest || points.last().second != rest ->
          "First and last values must equal rest value ${rest.toInt()}"
        points.any { (_, v) -> valueOutOfRange(name, v) } ->
          "alpha must be in 0..1 and scale values must be positive"
        else -> null
      }
    return message?.let { listOf(it) }
  }

  private fun valueOutOfRange(name: String, value: Double): Boolean =
    if (name == "alpha") value !in 0.0..1.0 else name.startsWith("scale") && value <= 0

  /** The (path, key) of every state-key trigger, for a state write to re-check. */
  fun stateKeyTriggers(context: PrototypeStateChecks.Context): List<Pair<String, String>> =
    context.nodes.mapNotNull { (node, path) ->
      ((node["keyframes"] as? JsonObject)?.get("trigger") as? JsonObject)?.text("key")?.let {
        path to it
      }
    }

  /** Unknown-state-key error for the first trigger whose key the candidate state lacks. */
  fun unknownTriggerKey(
    triggers: List<Pair<String, String>>,
    state: JsonObject?,
  ): PrototypeSpecError? =
    triggers
      .firstOrNull { (_, key) -> state?.containsKey(key) != true }
      ?.let { (path, _) -> fail("$path.keyframes.trigger.key", "Unknown state key") }
}
