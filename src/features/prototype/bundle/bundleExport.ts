import { logger } from "../../../utils/logger";
import type { PrototypeAssetMimeType } from "../prototypeAssets";
import { maxPrototypeAssetBytes, prototypeAssetIdProblem } from "../prototypeAssets";
import { savedPrototypeAssetPath } from "../savedPrototypeLayout";
import { requiredPrototypeCapabilities } from "../prototypeCapabilityGates";
import { parseBundleJson } from "./bundleJson";
import {
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
  BUNDLE_MAX_EXPANDED_BYTES,
  BUNDLE_MAX_COMPRESSED_BYTES,
  BundleFailure,
  bundleAssert,
  type BundleRejection,
} from "./bundleContract";
import {
  bundleSha256,
  bundleAssetTypeMatches,
  parseBundleManifest,
  type BundleManifestAsset,
} from "./bundleManifest";
import { bundleSpecReferences } from "./bundleSpec";
import { writeCanonicalBundleZip } from "./bundleZipWriter";

export interface BundleExportAsset {
  mediaType: PrototypeAssetMimeType;
  bytes: Uint8Array;
}
export interface BundleExportInput {
  specBytes: Uint8Array;
  assets: (id: string) => BundleExportAsset | undefined;
  fonts: (id: string) => BundleExportAsset | undefined;
}
export type BundleExportResult = { ok: true; bytes: Uint8Array } | BundleRejection;
function collect(
  ids: Set<string>,
  lookup: BundleExportInput["assets"],
  font: boolean,
  files: Map<string, Uint8Array>,
): BundleManifestAsset[] {
  return [...ids].sort().map((id) => {
    const asset = lookup(id);
    bundleAssert(asset, "asset_missing", id);
    if (asset.mediaType === "application/vnd.automobile.agsl") {
      throw new BundleFailure(
        "custom_shaders_unsupported",
        id,
        "ProtoViewer bundles refuse AGSL assets; remove custom shaders.",
      );
    }
    bundleAssert(prototypeAssetIdProblem(id) === null, "manifest_invalid", id);
    bundleAssert(
      asset.mediaType.startsWith("font/") === font &&
        bundleAssetTypeMatches(asset.mediaType, asset.bytes),
      "asset_type_mismatch",
      id,
    );
    bundleAssert(
      asset.bytes.length <= maxPrototypeAssetBytes(asset.mediaType),
      "entry_too_large",
      id,
    );
    const sha256 = bundleSha256(asset.bytes);
    const file = savedPrototypeAssetPath(asset.mediaType, sha256);
    files.set(file, asset.bytes);
    return { id, file, sha256, mediaType: asset.mediaType };
  });
}
export function canonicalBundleFiles(
  input: BundleExportInput,
  requires?: string[],
): Map<string, Uint8Array> {
  bundleAssert(input.specBytes.length <= BUNDLE_MAX_SPEC_BYTES, "entry_too_large", "spec.json");
  const references = bundleSpecReferences(input.specBytes);
  const files = new Map<string, Uint8Array>();
  const assets = collect(references.images, input.assets, false, files);
  const fonts = collect(references.fonts, input.fonts, true, files);
  const ids = new Set(assets.map((asset) => asset.id));
  for (const font of fonts) {
    bundleAssert(!ids.has(font.id), "manifest_invalid", font.id);
  }
  const manifest = {
    bundleFormatVersion: 1,
    specSha256: bundleSha256(input.specBytes),
    assets,
    fonts,
    requires:
      requires ??
      requiredPrototypeCapabilities(
        parseBundleJson(input.specBytes, "spec_invalid_json", "spec.json"),
      ),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  bundleAssert(manifestBytes.length <= BUNDLE_MAX_MANIFEST_BYTES, "entry_too_large", "bundle.json");
  parseBundleManifest(manifestBytes);
  const result = new Map<string, Uint8Array>([
    ["bundle.json", manifestBytes],
    ["spec.json", input.specBytes],
  ]);
  // ASCII comparison, never localeCompare (platform locales must not affect bytes).
  for (const path of [...files.keys()].sort()) {
    result.set(path, files.get(path)!);
  }
  bundleAssert(result.size <= BUNDLE_MAX_ENTRIES, "too_many_entries");
  bundleAssert(
    [...result.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= BUNDLE_MAX_EXPANDED_BYTES,
    "expanded_too_large",
  );
  return result;
}
export function exportPrototypeBundle(input: BundleExportInput): BundleExportResult {
  try {
    const bytes = writeCanonicalBundleZip(canonicalBundleFiles(input));
    bundleAssert(bytes.length <= BUNDLE_MAX_COMPRESSED_BYTES, "archive_too_large");
    return { ok: true, bytes };
  } catch (error) {
    logger.debug("Prototype bundle export rejected", error);
    return error instanceof BundleFailure
      ? error.rejection()
      : new BundleFailure("asset_missing", undefined, "Asset lookup failed").rejection();
  }
}
