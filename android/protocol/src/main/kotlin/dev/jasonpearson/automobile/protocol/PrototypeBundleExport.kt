package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.file
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.matchesType
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.parse
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.sha
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.validId
import kotlinx.serialization.json.*

data class PrototypeBundleExportInput(
  val specBytes: ByteArray,
  val assets: (String) -> PrototypeBundleAsset?,
  val fonts: (String) -> PrototypeBundleAsset?,
)

object PrototypeBundleExport {
  fun export(input: PrototypeBundleExportInput): PrototypeBundleExportResult =
    try {
      val bytes = PrototypeBundleZipWriter.write(canonicalFiles(input))
      bundleRequire(bytes.size <= PrototypeBundleLimits.MAX_COMPRESSED_BYTES, archive_too_large)
      PrototypeBundleExportResult.Success(bytes)
    } catch (error: PrototypeBundleFailure) {
      PrototypeBundleExportResult.Rejected(error.code, error.path)
    } catch (_: Exception) {
      // A caller-owned asset lookup may fail; no partial bytes escape this boundary.
      PrototypeBundleExportResult.Rejected(asset_missing)
    }

  internal fun canonicalFiles(
    input: PrototypeBundleExportInput,
    requires: List<String>? = null,
  ): Map<String, ByteArray> {
    bundleRequire(
      input.specBytes.size <= PrototypeBundleLimits.MAX_SPEC_BYTES,
      entry_too_large,
      "spec.json",
    )
    val refs = PrototypeBundleSpec.references(input.specBytes)
    val files = linkedMapOf<String, ByteArray>()
    val assets = collect(refs.images, input.assets, false, files)
    val fonts = collect(refs.fonts, input.fonts, true, files)
    val ids = assets.map { it.id }.toSet()
    for (font in fonts) bundleRequire(font.id !in ids, manifest_invalid, font.id)
    val manifest = buildJsonObject {
      put("bundleFormatVersion", 1)
      put("specSha256", sha(input.specBytes))
      put("assets", JsonArray(assets.map { it.json() }))
      put("fonts", JsonArray(fonts.map { it.json() }))
      put(
        "requires",
        JsonArray(
          (requires ?: PrototypeBundleCapabilities.required(refs)).map(::JsonPrimitive),
        ),
      )
    }
    val manifestBytes = encode(manifest).toByteArray(Charsets.UTF_8)
    bundleRequire(
      manifestBytes.size <= PrototypeBundleLimits.MAX_MANIFEST_BYTES,
      entry_too_large,
      "bundle.json",
    )
    parse(manifestBytes)
    val result = linkedMapOf("bundle.json" to manifestBytes, "spec.json" to input.specBytes)
    for (path in files.keys.sorted()) result[path] = files.getValue(path)
    bundleRequire(result.size <= PrototypeBundleLimits.MAX_ENTRIES, too_many_entries)
    bundleRequire(
      result.values.sumOf { it.size.toLong() } <= PrototypeBundleLimits.MAX_EXPANDED_BYTES,
      expanded_too_large,
    )
    return result
  }

  private fun collect(
    ids: Set<String>,
    lookup: (String) -> PrototypeBundleAsset?,
    font: Boolean,
    files: MutableMap<String, ByteArray>,
  ): List<PrototypeBundleManifestAsset> =
    ids.sorted().map { id ->
      val asset = lookup(id) ?: throw PrototypeBundleFailure(asset_missing, id)
      bundleRequire(validId(id), manifest_invalid, id)
      bundleRequire(
        asset.mediaType != "application/vnd.automobile.agsl",
        custom_shaders_unsupported,
        id,
      )
      bundleRequire(
        asset.mediaType.startsWith("font/") == font && matchesType(asset.mediaType, asset.bytes),
        asset_type_mismatch,
        id,
      )
      val cap =
        if (font) PrototypeAssetContract.MAX_PROTOTYPE_FONT_ASSET_BYTES
        else PrototypeAssetContract.MAX_PROTOTYPE_ASSET_BYTES
      bundleRequire(asset.bytes.size <= cap, entry_too_large, id)
      val sha = sha(asset.bytes)
      val file = file(asset.mediaType, sha)
      files[file] = asset.bytes
      PrototypeBundleManifestAsset(id, file, sha, asset.mediaType)
    }

  // Match JSON.stringify for lone surrogates, preserving UTF-16 identity and insertion order.
  private fun encode(value: JsonElement): String =
    when (value) {
      is JsonObject ->
        value.entries.joinToString(",", "{", "}") { (key, child) ->
          "${PrototypeSpecInput.canonicalString(key)}:${encode(child)}"
        }
      is JsonArray -> value.joinToString(",", "[", "]", transform = ::encode)
      is JsonPrimitive ->
        if (value.isString) PrototypeSpecInput.canonicalString(value.content) else value.toString()
    }
}
