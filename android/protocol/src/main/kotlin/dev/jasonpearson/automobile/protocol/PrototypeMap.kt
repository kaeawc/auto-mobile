package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Rules for the `map` node (#14309) that the contract cannot express, the twin of TypeScript's
 * `prototypeMap.ts`: a map needs `map` in `requires.platform`; `showUserLocation` reads the
 * `location` module, so it also needs `location` in `requires.platform` and the `location`
 * permission in `requires.permissions`; and `onCameraIdle.into` is a `/data` write path. Contract
 * only: no renderer draws a map.
 */
internal object PrototypeMap {
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
      else -> null
    }
  }
}
