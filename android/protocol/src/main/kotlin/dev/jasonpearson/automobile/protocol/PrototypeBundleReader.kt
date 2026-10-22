package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.matchesType
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.sha

object PrototypeBundleReader {
  fun read(bytes: ByteArray): PrototypeBundleReadResult =
    try {
      val files = PrototypeBundleZipReader.read(bytes)
      val manifestBytes =
        files["bundle.json"] ?: throw PrototypeBundleFailure(manifest_invalid, "bundle.json")
      val manifest = PrototypeBundleManifestCodec.parse(manifestBytes)
      val spec = files["spec.json"] ?: throw PrototypeBundleFailure(spec_invalid_json, "spec.json")
      val hash = sha(spec)
      bundleRequire(hash == manifest.specSha256, spec_sha_mismatch, "spec.json")
      val refs = PrototypeBundleSpec.references(spec)
      val assets = assetMap(manifest.assets, files, refs.images, false)
      val fonts = assetMap(manifest.fonts, files, refs.fonts, true)
      val listed = (manifest.assets + manifest.fonts).map { it.file }.toSet()
      for (path in files.keys) bundleRequire(
        path == "bundle.json" || path == "spec.json" || path in listed,
        manifest_entry_missing,
        path,
      )
      PrototypeBundleReadResult.Success(
        PrototypeBundle(spec, hash, assets, fonts, manifest.requires),
      )
    } catch (error: PrototypeBundleFailure) {
      PrototypeBundleReadResult.Rejected(error.code, error.path)
    }

  private fun assetMap(
    entries: List<PrototypeBundleManifestAsset>,
    files: Map<String, ByteArray>,
    references: Set<String>,
    font: Boolean,
  ): Map<String, PrototypeBundleAsset> {
    val result = linkedMapOf<String, PrototypeBundleAsset>()
    for (entry in entries) {
      val bytes =
        files[entry.file] ?: throw PrototypeBundleFailure(manifest_entry_missing, entry.file)
      bundleRequire(sha(bytes) == entry.sha256, sha256_mismatch, entry.file)
      bundleRequire(matchesType(entry.mediaType, bytes), asset_type_mismatch, entry.file)
      bundleRequire(entry.id in references, unreferenced_asset, entry.id)
      result[entry.id] = PrototypeBundleAsset(entry.mediaType, bytes)
    }
    for (id in references) bundleRequire(
      id in result,
      if (font) font_missing else asset_missing,
      id,
    )
    return result
  }
}
