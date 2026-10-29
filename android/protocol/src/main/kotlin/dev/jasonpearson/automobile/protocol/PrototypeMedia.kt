package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Rules for the root `media` block and the `media` platform module (#14253) that the contract
 * cannot express, the twin of TypeScript's `prototypeMedia.ts`: the block needs `media` in
 * `requires.platform`, `/platform/media` reads name a declared player and one of its state keys,
 * and a literal `player` argument names a declared player. Contract only: no runtime plays media.
 */
internal object PrototypeMedia {
  fun players(root: JsonObject): Set<String> =
    root.member("media")?.member("players")?.keys.orEmpty()

  fun error(root: JsonObject): PrototypeSpecError? {
    root.member("media") ?: return null
    val declared = root.member("requires")?.get("platform") as? JsonArray
    return if (declared?.contains(JsonPrimitive("media")) == true) null
    else fail("media", "Media players require media in requires.platform")
  }

  /** A `/media/players/<id>/<key>` read of a declared player's state key. */
  fun validRead(pointer: String, players: Set<String>): Boolean {
    val tokens = PrototypeDataPointer.tokens(pointer)
    val state = PrototypePlatformModules.module("media")?.member("state").orEmpty()
    return tokens.size == 4 && tokens[1] == "players" && tokens[2] in players && tokens[3] in state
  }

  /** A `media.*` call whose literal `player` argument names no declared player. */
  fun callError(action: JsonObject, path: String, players: Set<String>): PrototypeSpecError? {
    if (action.text("call")?.startsWith("media.") != true) return null
    val literal = action.member("args")?.member("player")?.get("value") as? JsonPrimitive
    val player = literal?.takeIf(JsonPrimitive::isString)?.content ?: return null
    return if (player in players) null else fail("$path.args.player.value", "Unknown media player")
  }
}
