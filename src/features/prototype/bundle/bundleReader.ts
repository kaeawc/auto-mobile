import { logger } from "../../../utils/logger";
import {
  bundleAssert,
  BundleFailure,
  type BundleReadResult,
  type BundleAsset,
  BUNDLE_MAX_COMPRESSED_BYTES,
} from "./bundleContract";
import { readBundleZip } from "./bundleZipReader";
import {
  bundleSha256,
  parseBundleManifest,
  bundleAssetTypeMatches,
  type BundleManifestAsset,
} from "./bundleManifest";
import { bundleSpecReferences } from "./bundleSpec";

function assetMap(
  entries: BundleManifestAsset[],
  files: Map<string, Uint8Array>,
  references: Set<string>,
  font: boolean,
): Map<string, BundleAsset> {
  const result = new Map<string, BundleAsset>();
  for (const entry of entries) {
    const bytes = files.get(entry.file);
    bundleAssert(bytes, "manifest_entry_missing", entry.file);
    bundleAssert(bundleSha256(bytes) === entry.sha256, "sha256_mismatch", entry.file);
    bundleAssert(bundleAssetTypeMatches(entry.mediaType, bytes), "asset_type_mismatch", entry.file);
    bundleAssert(references.has(entry.id), "unreferenced_asset", entry.id);
    result.set(entry.id, { mediaType: entry.mediaType, bytes, sha256: entry.sha256 });
  }
  for (const id of references) {
    bundleAssert(result.has(id), font ? "font_missing" : "asset_missing", id);
  }
  return result;
}
/** Pure synchronous reader. Hard zlib output limits bound allocation before returning any bytes.
 * The import UI applies library-specific policy/capability checks after this format/spec check.
 */
export function readPrototypeBundle(bytes: Uint8Array): BundleReadResult {
  try {
    bundleAssert(bytes.byteLength <= BUNDLE_MAX_COMPRESSED_BYTES, "archive_too_large");
    const files = readBundleZip(Buffer.from(bytes));
    const manifestBytes = files.get("bundle.json");
    bundleAssert(manifestBytes, "manifest_invalid", "bundle.json");
    const manifest = parseBundleManifest(manifestBytes);
    const spec = files.get("spec.json");
    bundleAssert(spec, "spec_invalid_json", "spec.json");
    const specSha256 = bundleSha256(spec);
    bundleAssert(specSha256 === manifest.specSha256, "spec_sha_mismatch", "spec.json");
    const references = bundleSpecReferences(spec);
    const assets = assetMap(manifest.assets, files, references.images, false);
    const fonts = assetMap(manifest.fonts, files, references.fonts, true);
    const listed = new Set([...manifest.assets, ...manifest.fonts].map((entry) => entry.file));
    for (const path of files.keys()) {
      bundleAssert(
        path === "bundle.json" || path === "spec.json" || listed.has(path),
        "manifest_entry_missing",
        path,
      );
    }
    return { ok: true, bundle: { spec, specSha256, assets, fonts, requires: manifest.requires } };
  } catch (error) {
    // Malformed archives are routine input, not exceptional operational failures.
    logger.debug("Prototype bundle rejected", error);
    return error instanceof BundleFailure
      ? error.rejection()
      : new BundleFailure("not_a_zip").rejection();
  }
}
