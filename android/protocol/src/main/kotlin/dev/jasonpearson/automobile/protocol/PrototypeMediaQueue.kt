package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Rules for a media player's `queue` (#14249) that the contract cannot express, the twin of
 * TypeScript's `prototypeMediaQueue.ts`: a player has exactly one of `source` or `queue`, the queue
 * points at a declared `/data` array, and each item is a `mediaQueueItem` with a unique `id`.
 */
internal object PrototypeMediaQueue {
  private val itemRule =
    JsonObject(mapOf("kind" to JsonPrimitive("ref"), "name" to JsonPrimitive("mediaQueueItem")))

  /** Whether any declared player has a queue, which needs prototype_platform_media_queue_v1. */
  fun queued(spec: JsonObject): Boolean =
    spec.member("media")?.member("players").orEmpty().values.any {
      (it as? JsonObject)?.containsKey("queue") == true
    }

  /** The first queue rule a spec's `media.players` break. */
  fun error(root: JsonObject): PrototypeSpecError? =
    root.member("media")?.member("players").orEmpty().firstNotNullOfOrNull { (id, raw) ->
      val player = raw as? JsonObject ?: return@firstNotNullOfOrNull null
      val path = keyPath("media.players", id)
      when {
        ("source" in player) == ("queue" in player) ->
          fail(path, "A media player needs exactly one of source or queue")
        "queue" in player -> queueError(root, player.text("queue"), "$path.queue")
        else -> null
      }
    }

  private fun queueError(root: JsonObject, queue: String?, path: String): PrototypeSpecError? {
    val notArray = fail(path, "queue must point to a /data array")
    val pointer =
      queue?.takeIf { it.startsWith("/data/") }?.removePrefix("/data") ?: return notArray
    val items = PrototypeDataPointer.resolve(root["data"], pointer) as? JsonArray ?: return notArray
    val base = PrototypeDataPointer.tokens(pointer).fold("data") { at, token -> keyPath(at, token) }
    val seen = HashSet<String?>()
    items.forEachIndexed { index, item ->
      val at = "$base[$index]"
      walk(item, itemRule, at, Context(), 0)?.let {
        return it
      }
      if (!seen.add((item as? JsonObject)?.text("id"))) {
        return fail("$at.id", "Duplicate queue item id")
      }
    }
    return null
  }
}
