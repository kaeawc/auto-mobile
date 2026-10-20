import { stableStringify } from "../../../utils/stableStringify";
import { validatePrototypeSpec } from "../prototypeValidation";
import { record } from "../prototypeTemplate";
import {
  type PrototypeAssetUpload,
  isPrototypeFontMimeType,
  prototypeAssetUploadProblem,
} from "../prototypeAssets";
import { BUNDLE_ASSET_LIMITS } from "./bundleLimits";
import { bundleAssert } from "./bundleErrors";
import { bundleSha256 } from "./bundleIntegrity";
import { bundleAssetPath, parseBundleManifest, type BundleManifestAsset } from "./bundleManifest";
import { bundleReferences } from "./bundleReferences";
import { writePrototypeZip } from "./prototypeZipWriter";
import { readPrototypeBundle } from "./prototypeZipReader";

export interface CanonicalBundleInput {
  spec: unknown;
  assets?: readonly PrototypeAssetUpload[];
  fonts?: readonly PrototypeAssetUpload[];
  requires?: readonly string[];
}
function canonicalJson(value: unknown): Buffer {
  return Buffer.from(stableStringify(value));
}
function exportSpec(input: unknown): {
  json: Buffer;
  references: ReturnType<typeof bundleReferences>;
} {
  const object = record(input);
  bundleAssert(object, "spec_invalid", "spec.json");
  // Only these top-level store-envelope fields are discarded. Nested opaque JSON and
  // authored state/data retain their semantics; unknown fields still fail the validator.
  const stripped = Object.fromEntries(
    Object.entries(object).filter(
      ([key]) =>
        ![
          "storage",
          "library",
          "source",
          "sourceUrl",
          "lastOpenedAt",
          "thumbnail",
          "label",
        ].includes(key),
    ),
  );
  const parsed = validatePrototypeSpec(stripped);
  bundleAssert(parsed.success, "spec_invalid", "spec.json");
  return { json: canonicalJson(stripped), references: bundleReferences(parsed.data) };
}
function exportRecords(
  uploads: readonly PrototypeAssetUpload[],
  referenced: Set<string>,
  fonts: boolean,
  entries: Map<string, Uint8Array>,
): BundleManifestAsset[] {
  const records: BundleManifestAsset[] = [];
  const seen = new Set<string>();
  bundleAssert(
    referenced.size <= BUNDLE_ASSET_LIMITS.MAX_PROTOTYPE_ASSET_COUNT,
    "manifest_invalid",
    "bundle.json",
  );
  for (const upload of uploads) {
    if (!referenced.has(upload.id)) {
      continue;
    }
    bundleAssert(
      !seen.has(upload.id) && isPrototypeFontMimeType(upload.mimeType) === fonts,
      "manifest_invalid",
      "bundle.json",
    );
    seen.add(upload.id);
    bundleAssert(!prototypeAssetUploadProblem(upload), "manifest_invalid", upload.id);
    const sha256 = bundleSha256(upload.bytes);
    const file = bundleAssetPath(upload.mimeType, sha256);
    entries.set(file, upload.bytes);
    records.push({ id: upload.id, file, sha256, mediaType: upload.mimeType });
  }
  for (const id of referenced) {
    bundleAssert(seen.has(id), "missing_entry", id);
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Rebuild, never re-zip a store directory. Extra supplied assets never enter the archive. */
export function exportCanonicalBundle(input: CanonicalBundleInput): Uint8Array {
  const spec = exportSpec(input.spec);
  const entries = new Map<string, Uint8Array>([["spec.json", spec.json]]);
  const manifest = parseBundleManifest({
    bundleFormatVersion: 1,
    specSha256: bundleSha256(spec.json),
    assets: exportRecords(input.assets ?? [], spec.references.assets, false, entries),
    fonts: exportRecords(input.fonts ?? [], spec.references.fonts, true, entries),
    requires: [...new Set(input.requires ?? [])].sort(),
  });
  entries.set("bundle.json", canonicalJson(manifest));
  const bytes = writePrototypeZip(entries);
  readPrototypeBundle(bytes); // Enforce exactly the reader's caps and cross-checks on exports.
  return bytes;
}
