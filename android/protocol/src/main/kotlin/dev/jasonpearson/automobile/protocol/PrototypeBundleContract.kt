package dev.jasonpearson.automobile.protocol

/** Closed transport error vocabulary shared with the TypeScript reader. */
enum class PrototypeBundleErrorCode {
  not_a_zip,
  entry_name_forbidden,
  entry_not_allowed,
  duplicate_entry,
  link_entry,
  encrypted_entry,
  method_unsupported,
  multi_disk,
  zip64_unsupported,
  extra_field_forbidden,
  header_mismatch,
  trailing_bytes,
  too_many_entries,
  entry_too_large,
  archive_too_large,
  expanded_too_large,
  ratio_exceeded,
  size_mismatch,
  crc_mismatch,
  sha256_mismatch,
  manifest_invalid,
  spec_sha_mismatch,
  spec_invalid_json,
  spec_invalid,
  asset_missing,
  font_missing,
  manifest_entry_missing,
  unreferenced_asset,
  asset_type_mismatch,
  requires_invalid,
}

object PrototypeBundleLimits {
  const val MAX_ENTRIES = 36
  const val MAX_SPEC_BYTES = 1048576
  const val MAX_MANIFEST_BYTES = 65536
  const val MAX_RATIO = 100
  const val MAX_JSON_DEPTH = 64
  val MAX_EXPANDED_BYTES =
    PrototypeAssetContract.MAX_PROTOTYPE_ASSET_TOTAL_BYTES + MAX_SPEC_BYTES + MAX_MANIFEST_BYTES
  val MAX_COMPRESSED_BYTES = MAX_EXPANDED_BYTES

  internal fun entryCap(name: String): Int =
    when {
      name == "spec.json" -> MAX_SPEC_BYTES
      name == "bundle.json" -> MAX_MANIFEST_BYTES
      name.startsWith("fonts/") -> PrototypeAssetContract.MAX_PROTOTYPE_FONT_ASSET_BYTES
      else -> PrototypeAssetContract.MAX_PROTOTYPE_ASSET_BYTES
    }
}

data class PrototypeBundleAsset(val mediaType: String, val bytes: ByteArray)

data class PrototypeBundle(
  val spec: ByteArray,
  val specSha256: String,
  val assets: Map<String, PrototypeBundleAsset>,
  val fonts: Map<String, PrototypeBundleAsset>,
  val requires: List<String>,
)

sealed interface PrototypeBundleReadResult {
  data class Success(val bundle: PrototypeBundle) : PrototypeBundleReadResult

  data class Rejected(val code: PrototypeBundleErrorCode, val path: String? = null) :
    PrototypeBundleReadResult
}

sealed interface PrototypeBundleExportResult {
  data class Success(val bytes: ByteArray) : PrototypeBundleExportResult

  data class Rejected(val code: PrototypeBundleErrorCode, val path: String? = null) :
    PrototypeBundleExportResult
}

internal class PrototypeBundleFailure(
  val code: PrototypeBundleErrorCode,
  val path: String? = null,
) : IllegalArgumentException(code.name)

internal fun bundleRequire(
  condition: Boolean,
  code: PrototypeBundleErrorCode,
  path: String? = null,
) {
  if (!condition) throw PrototypeBundleFailure(code, path)
}
