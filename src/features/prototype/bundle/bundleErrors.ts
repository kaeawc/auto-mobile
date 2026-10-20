import { ActionableError } from "../../../models/ActionableError";

/** Wire-stable rejection codes; Kotlin and Swift must mirror these spellings. */
export const BUNDLE_ERROR_CODES = [
  "entry_not_allowed",
  "duplicate_entry",
  "path_traversal",
  "non_ascii_name",
  "unsupported_method",
  "encrypted",
  "unix_mode_not_regular",
  "multi_disk",
  "too_many_entries",
  "compressed_too_large",
  "expanded_too_large",
  "ratio_exceeded",
  "size_mismatch",
  "crc_mismatch",
  "sha_mismatch",
  "eocd_invalid",
  "manifest_invalid",
  "spec_invalid",
  "missing_entry",
  "extra_data",
  "zip64_unsupported",
  "flags_unsupported",
  "zip_invalid",
  "inflate_invalid",
  "limits_invalid",
] as const;
export type BundleErrorCode = (typeof BUNDLE_ERROR_CODES)[number];

/** Structured, actionable failure. No logging or I/O is needed by this in-memory API. */
export class PrototypeBundleError extends ActionableError {
  constructor(
    readonly code: BundleErrorCode,
    readonly entry?: string,
    detail?: string,
  ) {
    super(`Prototype bundle: ${code}${entry ? ` (${entry})` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "PrototypeBundleError";
  }
}
export function bundleAssert(
  condition: unknown,
  code: BundleErrorCode,
  entry?: string,
  detail?: string,
): asserts condition {
  if (!condition) {
    throw new PrototypeBundleError(code, entry, detail);
  }
}
