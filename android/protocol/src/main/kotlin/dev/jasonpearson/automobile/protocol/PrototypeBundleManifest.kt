package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import java.security.MessageDigest
import kotlinx.serialization.json.*

internal data class PrototypeBundleManifestAsset(
  val id: String,
  val file: String,
  val sha256: String,
  val mediaType: String,
) {
  fun json(): JsonObject = buildJsonObject {
    put("id", id)
    put("file", file)
    put("sha256", sha256)
    put("mediaType", mediaType)
  }
}

internal data class PrototypeBundleManifest(
  val specSha256: String,
  val assets: List<PrototypeBundleManifestAsset>,
  val fonts: List<PrototypeBundleManifestAsset>,
  val requires: List<String>,
)

internal object PrototypeBundleManifestCodec {
  private val shaPattern = Regex("[0-9a-f]{64}")
  private val capabilityPattern = Regex("[a-z][a-z0-9_]*")
  // AGSL is deliberately excluded; records rejects it explicitly before this allowlist.
  private val extensions =
    mapOf(
      "image/png" to "png",
      "image/jpeg" to "jpg",
      "image/webp" to "webp",
      "font/ttf" to "ttf",
      "font/otf" to "otf",
    )

  fun sha(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
      "%02x".format(java.util.Locale.ROOT, it)
    }

  fun validId(id: String): Boolean =
    id.isNotEmpty() &&
      id.length <= PrototypeAssetContract.MAX_PROTOTYPE_ASSET_ID_LENGTH &&
      !PrototypeAssetContract.isMediaId(id)

  fun file(type: String, sha: String) =
    "${if (type.startsWith("font/")) "fonts" else "assets"}/$sha.${extensions.getValue(type)}"

  fun parse(bytes: ByteArray): PrototypeBundleManifest {
    val root = PrototypeBundleJson.parse(bytes, manifest_invalid, "bundle.json") as? JsonObject
    bundleRequire(
      root != null &&
        root.keys == setOf("bundleFormatVersion", "specSha256", "assets", "fonts", "requires"),
      manifest_invalid,
      "bundle.json",
    )
    val obj = checkNotNull(root)
    bundleRequire(
      (obj["bundleFormatVersion"] as? JsonPrimitive)?.let {
        !it.isString && it.doubleOrNull == 1.0
      } == true && shaPattern.matches(text(obj["specSha256"]).orEmpty()),
      manifest_invalid,
      "bundle.json",
    )
    val assets = records(obj["assets"])
    val fonts = records(obj["fonts"])
    val requires = obj["requires"] as? JsonArray
    bundleRequire(
      requires != null && requires.all { text(it)?.let(capabilityPattern::matches) == true },
      requires_invalid,
      "bundle.json",
    )
    val names = checkNotNull(requires).map { checkNotNull(text(it)) }
    bundleRequire(names.zipWithNext().all { (a, b) -> a < b }, requires_invalid, "bundle.json")
    val ids = HashSet<String>()
    for ((entries, font) in listOf(assets to false, fonts to true)) for (entry in entries) {
      bundleRequire(ids.add(entry.id), manifest_invalid, entry.id)
      bundleRequire(entry.mediaType.startsWith("font/") == font, manifest_invalid, entry.file)
      bundleRequire(entry.file == file(entry.mediaType, entry.sha256), manifest_invalid, entry.file)
    }
    return PrototypeBundleManifest(checkNotNull(text(obj["specSha256"])), assets, fonts, names)
  }

  private fun records(value: JsonElement?): List<PrototypeBundleManifestAsset> {
    bundleRequire(value is JsonArray, manifest_invalid, "bundle.json")
    return (value as JsonArray).map {
      val record = it as? JsonObject
      bundleRequire(
        record != null && record.keys == setOf("id", "file", "sha256", "mediaType"),
        manifest_invalid,
        "bundle.json",
      )
      val obj = checkNotNull(record)
      val id = text(obj["id"])
      val file = text(obj["file"])
      val sha = text(obj["sha256"])
      val type = text(obj["mediaType"])
      bundleRequire(
        type != "application/vnd.automobile.agsl",
        custom_shaders_unsupported,
        "bundle.json",
      )
      bundleRequire(
        id != null &&
          validId(id) &&
          file != null &&
          sha != null &&
          shaPattern.matches(sha) &&
          type in extensions,
        manifest_invalid,
        "bundle.json",
      )
      PrototypeBundleManifestAsset(
        checkNotNull(id),
        checkNotNull(file),
        checkNotNull(sha),
        checkNotNull(type),
      )
    }
  }

  internal fun text(value: JsonElement?): String? =
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content

  fun matchesType(type: String, bytes: ByteArray): Boolean {
    fun prefix(vararg values: Int) =
      bytes.size >= values.size && values.indices.all { bytes[it].toInt() and 255 == values[it] }
    fun tag(at: Int, value: String) =
      bytes.size >= at + value.length &&
        bytes.copyOfRange(at, at + value.length).toString(Charsets.US_ASCII) == value
    return when (type) {
      "image/png" -> prefix(137, 80, 78, 71, 13, 10, 26, 10)
      "image/jpeg" -> prefix(255, 216, 255)
      "image/webp" -> tag(0, "RIFF") && tag(8, "WEBP")
      "font/ttf" -> prefix(0, 1, 0, 0) || tag(0, "true")
      "font/otf" -> tag(0, "OTTO")
      else -> false
    }
  }
}
