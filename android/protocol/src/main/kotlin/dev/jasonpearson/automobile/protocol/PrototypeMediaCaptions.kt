package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Rules for `videoPlayer.captions` (#14259) that the contract cannot express, the twin of
 * TypeScript's `prototypeMediaCaptions.ts`: track ids are unique per player and never use the
 * `hls:` prefix in-band tracks own, and `/data` cues point at a declared array of `mediaCaptionCue`
 * objects that each end after they start.
 */
internal object PrototypeMediaCaptions {
  private val cueRule =
    JsonObject(mapOf("kind" to JsonPrimitive("ref"), "name" to JsonPrimitive("mediaCaptionCue")))

  /** The first caption rule a spec's `videoPlayer` nodes break. */
  fun error(root: JsonObject, nodes: List<Located>): PrototypeSpecError? =
    nodes
      .filter { it.value.text("type") == "videoPlayer" }
      .firstNotNullOfOrNull { (node, path) ->
        (node["captions"] as? JsonArray)?.let { playerError(root, it, "$path.captions") }
      }

  private fun playerError(
    root: JsonObject,
    captions: JsonArray,
    path: String,
  ): PrototypeSpecError? {
    val seen = HashSet<String?>()
    captions.forEachIndexed { index, raw ->
      val caption = raw as? JsonObject ?: return@forEachIndexed
      val at = "$path[$index]"
      val id = caption.text("id")
      if (id?.startsWith("hls:") == true) {
        return fail("$at.id", "Caption ids starting with hls: are reserved")
      }
      if (!seen.add(id)) return fail("$at.id", "Duplicate caption id")
      val data = caption.member("source")?.get("data") ?: return@forEachIndexed
      cuesError(root, (data as? JsonPrimitive)?.content, "$at.source.data")?.let {
        return it
      }
    }
    return null
  }

  private fun cuesError(root: JsonObject, data: String?, path: String): PrototypeSpecError? {
    val notArray = fail(path, "Caption data must point to a /data array")
    val pointer = data?.takeIf { it.startsWith("/data/") }?.removePrefix("/data") ?: return notArray
    val cues = PrototypeDataPointer.resolve(root["data"], pointer) as? JsonArray ?: return notArray
    val base = PrototypeDataPointer.tokens(pointer).fold("data") { at, token -> keyPath(at, token) }
    cues.forEachIndexed { index, cue ->
      val at = "$base[$index]"
      walk(cue, cueRule, at, Context(), 0)?.let {
        return it
      }
      val start = ((cue as? JsonObject)?.get("startMs") as? JsonPrimitive)?.doubleOrNull
      val end = ((cue as? JsonObject)?.get("endMs") as? JsonPrimitive)?.doubleOrNull
      if (start != null && end != null && end <= start) {
        return fail("$at.endMs", "A caption cue must end after it starts")
      }
    }
    return null
  }
}
