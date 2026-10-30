package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Rules for the root `media` block and the `media` platform module (#14253) that the contract
 * cannot express, the twin of TypeScript's `prototypeMedia.ts`: the block needs `media` in
 * `requires.platform`, `/platform/media` reads name a declared player and one of its state keys,
 * and a literal `player` argument names a declared player. Contract only: no runtime plays media.
 */
internal object PrototypeMedia {
  private fun declaredPlayers(root: JsonObject): Set<String> =
    root.member("media")?.member("players")?.keys.orEmpty()

  /**
   * The player ids `media.*` calls and `/platform/media` reads may name: the root `media.players`
   * block, plus the node-scoped player of each `videoPlayer` with an inline `source`, keyed by its
   * id.
   */
  fun players(root: JsonObject, nodes: List<Located>): Set<String> =
    declaredPlayers(root) +
      nodes
        .map { it.value }
        .filter { it.text("type") == "videoPlayer" && "source" in it }
        .mapNotNull { it.text("id") }

  /** The first `videoPlayer` node rule a spec breaks. */
  fun videoPlayerError(root: JsonObject, nodes: List<Located>): PrototypeSpecError? {
    val declared = declaredPlayers(root)
    val media =
      (root.member("requires")?.get("platform") as? JsonArray)?.contains(JsonPrimitive("media")) ==
        true
    val state = root.member("state").orEmpty()
    for ((node, path) in nodes.filter { it.value.text("type") == "videoPlayer" }) {
      nodeError(node, path, declared, media, state)?.let {
        return it
      }
    }
    return null
  }

  private fun nodeError(
    node: JsonObject,
    path: String,
    declared: Set<String>,
    media: Boolean,
    state: Map<String, JsonElement>,
  ): PrototypeSpecError? {
    val positionKey = node.text("positionKey")
    return when {
      !media -> fail(path, "videoPlayer requires media in requires.platform")
      ("player" in node) == ("source" in node) ->
        fail(path, "A videoPlayer needs exactly one of player or source")
      node.text("player")?.let { it !in declared } == true ->
        fail("$path.player", "Unknown media player")
      "source" in node -> inlineError(node.text("id"), path, declared)
      else -> null
    }
      ?: positionKey
        ?.takeUnless { (state[it] as? JsonPrimitive)?.let(::isNumber) == true }
        ?.let { fail("$path.positionKey", "positionKey must name a declared number state key") }
  }

  /**
   * The first `castButton` node rule a spec breaks (#14239): it needs `cast` in `requires.platform`
   * and its `player` names a declared or inline media player.
   */
  fun castButtonError(root: JsonObject, nodes: List<Located>): PrototypeSpecError? {
    val cast =
      (root.member("requires")?.get("platform") as? JsonArray)?.contains(JsonPrimitive("cast")) ==
        true
    val players = players(root, nodes)
    return nodes
      .filter { it.value.text("type") == "castButton" }
      .firstNotNullOfOrNull { (node, path) ->
        when {
          !cast -> fail(path, "castButton requires cast in requires.platform")
          node.text("player")?.let { it !in players } == true ->
            fail("$path.player", "Unknown media player")
          else -> null
        }
      }
  }

  private fun isNumber(value: JsonPrimitive): Boolean =
    !value.isString && value.doubleOrNull != null

  /** A node-scoped player is addressed by its id, so the id must be a fresh state key. */
  private fun inlineError(id: String?, path: String, declared: Set<String>): PrototypeSpecError? =
    when {
      id == null || !PrototypeSpecValidator.stateKeyPattern.matches(id) ->
        fail(path, "An inline videoPlayer needs an id that is a state key")
      id in declared -> fail("$path.id", "An inline videoPlayer id cannot repeat a declared player")
      else -> null
    }

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
