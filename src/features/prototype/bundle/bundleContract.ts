import { MAX_PROTOTYPE_ASSET_TOTAL_BYTES } from "../prototypeAssets";
import type { PrototypeAssetMimeType } from "../prototypeAssets";

// Fixed by #13616: 2 JSON files + 32 contract assets + 2 fonts headroom.
export const BUNDLE_MAX_ENTRIES = 36;
export const BUNDLE_MAX_SPEC_BYTES = 1048576;
export const BUNDLE_MAX_MANIFEST_BYTES = 65536;
export const BUNDLE_MAX_EXPANDED_BYTES =
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES + BUNDLE_MAX_SPEC_BYTES + BUNDLE_MAX_MANIFEST_BYTES;
export const BUNDLE_MAX_COMPRESSED_BYTES = BUNDLE_MAX_EXPANDED_BYTES;
export const BUNDLE_MAX_RATIO = 100;
export const BUNDLE_MAX_JSON_DEPTH = 64;

/** Ordered cross-language error vocabulary. Never infer codes from exception messages. */
export const BUNDLE_ERROR_CODES = [
  "not_a_zip",
  "entry_name_forbidden",
  "entry_not_allowed",
  "duplicate_entry",
  "link_entry",
  "encrypted_entry",
  "method_unsupported",
  "multi_disk",
  "zip64_unsupported",
  "extra_field_forbidden",
  "header_mismatch",
  "trailing_bytes",
  "too_many_entries",
  "entry_too_large",
  "archive_too_large",
  "expanded_too_large",
  "ratio_exceeded",
  "size_mismatch",
  "crc_mismatch",
  "sha256_mismatch",
  "manifest_invalid",
  "spec_sha_mismatch",
  "spec_invalid_json",
  "spec_invalid",
  "asset_missing",
  "font_missing",
  "manifest_entry_missing",
  "unreferenced_asset",
  "asset_type_mismatch",
  "requires_invalid",
] as const;
export type BundleErrorCode = (typeof BUNDLE_ERROR_CODES)[number];
export interface BundleRejection {
  ok: false;
  code: BundleErrorCode;
  path?: string;
  message: string;
}
export interface BundleAsset {
  mediaType: PrototypeAssetMimeType;
  bytes: Uint8Array;
  sha256: string;
}
export interface PrototypeBundle {
  spec: Uint8Array;
  specSha256: string;
  assets: Map<string, BundleAsset>;
  fonts: Map<string, BundleAsset>;
  requires: string[];
}
export type BundleReadResult = { ok: true; bundle: PrototypeBundle } | BundleRejection;
export class BundleFailure extends Error {
  constructor(
    readonly code: BundleErrorCode,
    readonly path?: string,
    message = code as string,
  ) {
    super(message);
  }
  rejection(): BundleRejection {
    return {
      ok: false,
      code: this.code,
      ...(this.path === undefined ? {} : { path: this.path }),
      message: this.message,
    };
  }
}
export function bundleAssert(
  condition: unknown,
  code: BundleErrorCode,
  path?: string,
): asserts condition {
  if (!condition) {
    throw new BundleFailure(code, path);
  }
}
