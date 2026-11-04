package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Rules for the `map` node (#14309) that the contract cannot express, the twin of TypeScript's
 * `prototypeMap.ts`: a map needs `map` in `requires.platform`; `showUserLocation` reads the
 * `location` module, so it also needs `location` in `requires.platform` and the `location`
 * permission in `requires.permissions`; `onCameraIdle.into` is a `/data` write path; and an `emit`
 * that `onMarkerTap` runs cannot author a context name the runtime adds (`markerId`, #16492).
 * Contract only: no renderer draws a map.
 */
internal object PrototypeMap {
  /** Emit-context names the runtime adds to every `emit` a marker tap runs (#16492). */
  val markerTapEmitContext: List<String> =
    PrototypePlatformModules.module("map")
      ?.member("events")
      ?.member("markerTap")
      ?.strings("emitContext")
      .orEmpty()

  /** Action lists nested in an action; a marker tap's id stays fixed for all of them. */
  private val nestedActionLists = listOf("onSuccess", "onError", "actions")

  private class Scope(root: JsonObject) {
    private val requires = root.member("requires")
    private val platform = requires?.get("platform") as? JsonArray
    val map = platform?.contains(JsonPrimitive("map")) == true
    val location = platform?.contains(JsonPrimitive("location")) == true
    val permission =
      (requires?.get("permissions") as? JsonArray)?.any {
        (it as? JsonObject)?.text("name") == "location"
      } == true
  }

  /** The first `map` node rule a spec breaks. */
  fun error(root: JsonObject, nodes: List<Located>): PrototypeSpecError? {
    val maps = nodes.filter { it.value.text("type") == "map" }
    if (maps.isEmpty()) return null
    val scope = Scope(root)
    return maps.firstNotNullOfOrNull { (node, path) -> nodeError(node, path, scope) }
  }

  private fun nodeError(node: JsonObject, path: String, scope: Scope): PrototypeSpecError? {
    val showsUser = (node["showUserLocation"] as? JsonPrimitive)?.booleanOrNull == true
    val into = (node.member("onCameraIdle")?.get("into") as? JsonPrimitive)?.contentOrNull
    return when {
      !scope.map -> fail(path, "map requires map in requires.platform")
      showsUser && !scope.location ->
        fail("$path.showUserLocation", "showUserLocation requires location in requires.platform")
      showsUser && !scope.permission ->
        fail(
          "$path.showUserLocation",
          "showUserLocation requires permission location in requires.permissions",
        )
      into != null && PrototypeDataWriter.pathPointer(into) == null ->
        fail("$path.onCameraIdle.into", "onCameraIdle.into must be a /data/<pointer> path")
      else -> markerTapContextError(node["onMarkerTap"], "$path.onMarkerTap")
    }
  }

  /** The first emit under a marker tap, depth first, whose context authors a runtime-added name. */
  private fun markerTapContextError(actions: JsonElement?, path: String): PrototypeSpecError? {
    (actions as? JsonArray)?.forEachIndexed { index, entry ->
      val action = entry as? JsonObject ?: return@forEachIndexed
      val at = "$path[$index]"
      val context = if (action.text("type") == "emit") action.member("context") else null
      markerTapEmitContext
        .firstOrNull { context?.containsKey(it) == true }
        ?.let {
          return fail(
            "$at.context.$it",
            "$it is reserved in an onMarkerTap emit context: the runtime sets it to the tapped marker's id",
          )
        }
      nestedActionLists
        .firstNotNullOfOrNull { markerTapContextError(action[it], "$at.$it") }
        ?.let {
          return it
        }
    }
    return null
  }
}
