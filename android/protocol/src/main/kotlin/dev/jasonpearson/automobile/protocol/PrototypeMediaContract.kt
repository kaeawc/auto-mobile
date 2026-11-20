package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Prototype media asset contract (#14254): video, audio and WebVTT captions, read from the `media`
 * section of the same `schemas/prototype-asset-contract.json` TypeScript imports. Media has its own
 * budget, separate from images and fonts, and arrives in chunks rather than one base64 frame.
 */
object PrototypeMediaContract {
  private val media: JsonObject =
    Json.parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/prototype-asset-contract.json")) {
            "Missing prototype asset contract"
          }
          .bufferedReader()
          .use { it.readText() },
      )
      .jsonObject
      .getValue("media")
      .jsonObject
  private val limits = media.getValue("limits").jsonObject

  /** Largest video or audio asset, in bytes. */
  val MAX_PROTOTYPE_MEDIA_ASSET_BYTES: Int = limit("MAX_PROTOTYPE_MEDIA_ASSET_BYTES")

  /** Largest WebVTT caption asset, in bytes. */
  val MAX_PROTOTYPE_VTT_ASSET_BYTES: Int = limit("MAX_PROTOTYPE_VTT_ASSET_BYTES")

  /** Most media assets held at once, committed and in flight together. */
  val MAX_PROTOTYPE_MEDIA_ASSET_COUNT: Int = limit("MAX_PROTOTYPE_MEDIA_ASSET_COUNT")

  /** Most bytes held across media assets, committed and in flight together. */
  val MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES: Int = limit("MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES")

  /** Largest decoded chunk. */
  val MAX_PROTOTYPE_MEDIA_CHUNK_BYTES: Int = limit("MAX_PROTOTYPE_MEDIA_CHUNK_BYTES")

  /** Accepted media MIME types, exact lowercase match; never part of the single-frame allowlist. */
  val MIME_TYPES: Set<String> =
    media.getValue("mimeTypes").jsonArray.map { it.jsonPrimitive.content }.toSet()

  /** Leading bytes that decide every signature; a shorter file is judged on all it has. */
  const val SIGNATURE_PROBE_BYTES = 16

  const val VTT_MIME_TYPE = "text/vtt"

  fun maxAssetBytes(mimeType: String): Int =
    if (mimeType == VTT_MIME_TYPE) MAX_PROTOTYPE_VTT_ASSET_BYTES
    else MAX_PROTOTYPE_MEDIA_ASSET_BYTES

  /**
   * Whether [head] matches [mimeType]'s container signature: an ISO BMFF `ftyp` box at offset 4
   * (MP4 and M4A share it), the EBML magic (WebM), an ID3 tag or MPEG frame sync (MP3), `OggS`, or
   * a `WEBVTT` header after an optional UTF-8 BOM. Mirrors `prototypeMediaSignatureMatches` in
   * TypeScript; both run `test/fixtures/prototype-media-transport/cases.json`.
   */
  fun signatureMatches(mimeType: String, head: ByteArray): Boolean =
    when (mimeType) {
      "video/mp4",
      "audio/mp4" -> head.startsWith(FTYP, at = 4)
      "video/webm" -> head.startsWith(EBML)
      "audio/mpeg" ->
        head.startsWith(ID3) ||
          (head.size >= 2 && head[0].toInt() and 0xff == 0xff && head[1].toInt() and 0xe0 == 0xe0)
      "audio/ogg" -> head.startsWith(OGGS)
      VTT_MIME_TYPE -> isWebVttHeader(head)
      else -> false
    }

  private val FTYP = bytes(0x66, 0x74, 0x79, 0x70)
  private val EBML = bytes(0x1a, 0x45, 0xdf, 0xa3)
  private val ID3 = bytes(0x49, 0x44, 0x33)
  private val OGGS = bytes(0x4f, 0x67, 0x67, 0x53)
  private val UTF8_BOM = bytes(0xef, 0xbb, 0xbf)
  private val WEBVTT = bytes(0x57, 0x45, 0x42, 0x56, 0x54, 0x54)
  private val WEBVTT_TERMINATORS = setOf(0x20, 0x09, 0x0a, 0x0d)

  private fun isWebVttHeader(head: ByteArray): Boolean {
    val start = if (head.startsWith(UTF8_BOM)) UTF8_BOM.size else 0
    if (!head.startsWith(WEBVTT, at = start)) return false
    val next = start + WEBVTT.size
    return next == head.size || (head[next].toInt() and 0xff) in WEBVTT_TERMINATORS
  }

  private fun ByteArray.startsWith(prefix: ByteArray, at: Int = 0): Boolean =
    size >= at + prefix.size && prefix.indices.all { this[at + it] == prefix[it] }

  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  private fun limit(name: String) = limits.getValue(name).jsonPrimitive.int
}
