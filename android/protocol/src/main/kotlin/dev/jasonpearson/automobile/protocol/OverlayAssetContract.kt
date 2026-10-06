package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Transport limits for overlay image assets (#9301), read from the same
 * `schemas/overlay-asset-contract.json` that TypeScript imports so the host and the device cannot
 * disagree. The overlay spec carries only opaque asset ids; bytes, MIME types and caps live here.
 *
 * The caps are conservative choices, not spec values: the heap, not the 64 MiB frame limit, is the
 * binding constraint (a 16 MB base64 payload decoded in 38 ms but 32 MB threw OutOfMemoryError on a
 * 192 MB heap), so a 4 MiB asset leaves a wide margin.
 */
object OverlayAssetContract {
  private val contract: JsonObject =
    Json.parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/overlay-asset-contract.json")) {
            "Missing overlay asset contract"
          }
          .bufferedReader()
          .use { it.readText() }
      )
      .jsonObject
  private val limits = contract.getValue("limits").jsonObject

  /** Largest single asset, in decoded bytes. */
  val MAX_OVERLAY_ASSET_BYTES: Int = limit("MAX_OVERLAY_ASSET_BYTES")

  /** Most assets held at once. */
  val MAX_OVERLAY_ASSET_COUNT: Int = limit("MAX_OVERLAY_ASSET_COUNT")

  /** Most decoded bytes held across all assets. */
  val MAX_OVERLAY_ASSET_TOTAL_BYTES: Int = limit("MAX_OVERLAY_ASSET_TOTAL_BYTES")

  /** Longest accepted asset id, in UTF-16 chars. Ids are otherwise opaque nonempty strings. */
  val MAX_OVERLAY_ASSET_ID_LENGTH: Int = limit("MAX_OVERLAY_ASSET_ID_LENGTH")

  /** Accepted MIME types, exact lowercase match. */
  val MIME_TYPES: Set<String> =
    contract.getValue("mimeTypes").jsonArray.map { it.jsonPrimitive.content }.toSet()

  private fun limit(name: String) = limits.getValue(name).jsonPrimitive.int
}
