package dev.jasonpearson.automobile.protoviewer

import androidx.annotation.StringRes
import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode

/**
 * The string resource shown for an import rejection. [LibraryImportResult.Rejected.reason] stays a
 * stable English token for MCP results; users only ever see a translated message.
 */
@StringRes
internal fun importRejectionReason(rejected: LibraryImportResult.Rejected): Int {
  val reason = rejected.reason
  return when {
    reason == IMPORT_REASON_URI_REQUIRED -> R.string.import_reason_uri_required
    reason == IMPORT_REASON_TOO_LARGE -> R.string.import_reason_too_large
    reason == IMPORT_REASON_UNREADABLE -> R.string.import_reason_unreadable
    reason == IMPORT_REASON_INVALID_IMAGE -> R.string.import_reason_invalid_image
    reason == UNSUPPORTED_PROTOTYPE_REASON -> R.string.unsupported
    // Spec policy messages come from the shared validator in English; the path names the field.
    rejected.path.startsWith("spec.json:") -> R.string.import_reason_spec_invalid
    rejected.path == "library" ->
      LibraryError.entries.firstOrNull { it.name == reason }?.let(::libraryErrorReason)
        ?: R.string.import_reason_invalid
    else ->
      PrototypeBundleErrorCode.entries.firstOrNull { it.name == reason }?.let(::bundleErrorReason)
        ?: R.string.import_reason_invalid
  }
}

@StringRes
internal fun libraryErrorReason(error: LibraryError): Int =
  when (error) {
    LibraryError.NotFound -> R.string.import_reason_not_found
    LibraryError.Corrupt -> R.string.import_reason_corrupt
    LibraryError.UnsupportedFormat -> R.string.unsupported
    LibraryError.Storage -> R.string.import_reason_storage
    LibraryError.Limit -> R.string.import_reason_library_full
    LibraryError.Invalid -> R.string.import_reason_invalid
    LibraryError.Hidden -> R.string.import_hidden
  }

/** Exhaustive on purpose: a new transport code must choose its user-facing message. */
@StringRes
@Suppress("CyclomaticComplexMethod") // One branch group per closed transport error code.
internal fun bundleErrorReason(code: PrototypeBundleErrorCode): Int =
  when (code) {
    PrototypeBundleErrorCode.not_a_zip,
    PrototypeBundleErrorCode.entry_name_forbidden,
    PrototypeBundleErrorCode.entry_not_allowed,
    PrototypeBundleErrorCode.duplicate_entry,
    PrototypeBundleErrorCode.link_entry,
    PrototypeBundleErrorCode.encrypted_entry,
    PrototypeBundleErrorCode.method_unsupported,
    PrototypeBundleErrorCode.multi_disk,
    PrototypeBundleErrorCode.zip64_unsupported,
    PrototypeBundleErrorCode.extra_field_forbidden,
    PrototypeBundleErrorCode.header_mismatch,
    PrototypeBundleErrorCode.trailing_bytes -> R.string.import_reason_archive_invalid
    PrototypeBundleErrorCode.too_many_entries,
    PrototypeBundleErrorCode.entry_too_large,
    PrototypeBundleErrorCode.archive_too_large,
    PrototypeBundleErrorCode.expanded_too_large,
    PrototypeBundleErrorCode.ratio_exceeded -> R.string.import_reason_too_large
    PrototypeBundleErrorCode.size_mismatch,
    PrototypeBundleErrorCode.crc_mismatch,
    PrototypeBundleErrorCode.sha256_mismatch,
    PrototypeBundleErrorCode.spec_sha_mismatch -> R.string.import_reason_integrity
    PrototypeBundleErrorCode.manifest_invalid,
    PrototypeBundleErrorCode.manifest_entry_missing,
    PrototypeBundleErrorCode.requires_invalid -> R.string.import_reason_manifest_invalid
    PrototypeBundleErrorCode.spec_invalid_json,
    PrototypeBundleErrorCode.spec_invalid -> R.string.import_reason_spec_invalid
    PrototypeBundleErrorCode.asset_missing,
    PrototypeBundleErrorCode.font_missing,
    PrototypeBundleErrorCode.unreferenced_asset,
    PrototypeBundleErrorCode.asset_type_mismatch -> R.string.import_reason_asset_invalid
    PrototypeBundleErrorCode.custom_shaders_unsupported -> R.string.import_reason_custom_shaders
  }

/** A share-warning line; `%1$s` is the technical JSON path, which is never translated. */
@StringRes
internal fun shareWarningText(code: String): Int =
  when (code) {
    "credential_header" -> R.string.share_warning_credential_header
    "credential_query" -> R.string.share_warning_credential_query
    "private_host" -> R.string.share_warning_private_host
    else -> R.string.share_warning_other
  }
