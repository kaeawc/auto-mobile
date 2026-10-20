import { record } from "../prototypeTemplate";
import { validatePrototypeSpec } from "../prototypeValidation";
import { detectFontMimeType, prototypeAssetUploadProblem } from "../prototypeAssets";
import { bundleAssert, PrototypeBundleError } from "./bundleErrors";
import { bundleSha256 } from "./bundleIntegrity";
import { resolveBundleLimits, type BundleLimits } from "./bundleLimits";
import {
  parseBundleJson,
  parseBundleManifest,
  type BundleManifest,
  type BundleManifestAsset,
} from "./bundleManifest";
import { bundleReferences, type BundleReferences } from "./bundleReferences";
import { readZipDirectory } from "./zipDirectory";
import { inflateZipEntries } from "./zipInflate";
import { detectImageMimeType } from "../../../utils/screenshot/imageHeaderDimensions";

export interface PrototypeBundle {
  manifest: BundleManifest;
  specJson: string;
  assets: Map<string, Uint8Array>;
  fonts: Map<string, Uint8Array>;
}
function utf8(bytes: Uint8Array, entry: "bundle.json" | "spec.json"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new PrototypeBundleError(
      entry === "bundle.json" ? "manifest_invalid" : "spec_invalid",
      entry,
      error instanceof Error ? error.message : "Invalid UTF-8",
    );
  }
}
function requiredEntry(entries: Map<string, Buffer>, name: string): Buffer {
  const bytes = entries.get(name);
  bundleAssert(bytes, "missing_entry", name);
  return bytes;
}
function checkRecords(
  records: BundleManifestAsset[],
  references: Set<string>,
  entries: Map<string, Buffer>,
): Map<string, Uint8Array> {
  const ids = new Set(records.map((item) => item.id));
  for (const id of references) {
    bundleAssert(ids.has(id), "missing_entry", id);
  }
  const out = new Map<string, Uint8Array>();
  for (const item of records) {
    bundleAssert(references.has(item.id), "manifest_invalid", "bundle.json");
    const bytes = requiredEntry(entries, item.file);
    bundleAssert(bundleSha256(bytes) === item.sha256, "sha_mismatch", item.file);
    bundleAssert(
      !prototypeAssetUploadProblem({ id: item.id, mimeType: item.mediaType, bytes }),
      "manifest_invalid",
      item.file,
    );
    bundleAssert(
      item.mediaType.startsWith("font/")
        ? detectFontMimeType(bytes) === item.mediaType
        : detectImageMimeType(bytes) === item.mediaType,
      "manifest_invalid",
      item.file,
    );
    out.set(item.sha256, bytes);
  }
  return out;
}
function bundleContents(entries: Map<string, Buffer>, limits: BundleLimits): PrototypeBundle {
  const manifest = parseBundleManifest(
    parseBundleJson(utf8(requiredEntry(entries, "bundle.json"), "bundle.json"), "bundle.json"),
  );
  const specBytes = requiredEntry(entries, "spec.json");
  bundleAssert(bundleSha256(specBytes) === manifest.specSha256, "sha_mismatch", "spec.json");
  const specJson = utf8(specBytes, "spec.json");
  const decoded = parseBundleJson(specJson, "spec.json");
  const parsed = validatePrototypeSpec(decoded);
  bundleAssert(parsed.success, "spec_invalid", "spec.json");
  // Storage is local policy and never a transport field.
  bundleAssert(!Object.hasOwn(record(decoded) ?? {}, "storage"), "spec_invalid", "spec.json");
  const references: BundleReferences = bundleReferences(parsed.data);
  const allowed = new Set([
    "bundle.json",
    "spec.json",
    ...manifest.assets.map((item) => item.file),
    ...manifest.fonts.map((item) => item.file),
  ]);
  let assetTotal = 0;
  for (const [name, bytes] of entries) {
    bundleAssert(allowed.has(name), "entry_not_allowed", name);
    if (name !== "bundle.json" && name !== "spec.json") {
      assetTotal += bytes.length;
    }
  }
  bundleAssert(assetTotal <= limits.maxAssetBytes, "expanded_too_large");
  return {
    manifest,
    specJson,
    assets: checkRecords(manifest.assets, references.assets, entries),
    fonts: checkRecords(manifest.fonts, references.fonts, entries),
  };
}
/** Pure in-memory reader. Throws PrototypeBundleError (code, entry, message) on rejection. */
export function readPrototypeBundle(
  input: Uint8Array,
  overrides?: Partial<BundleLimits>,
): PrototypeBundle {
  const limits = resolveBundleLimits(overrides);
  bundleAssert(input.byteLength <= limits.maxCompressedBytes, "compressed_too_large");
  // A private snapshot makes mutation of the caller's bytes unable to change validation.
  const bytes = Buffer.from(input);
  return bundleContents(inflateZipEntries(bytes, readZipDirectory(bytes, limits), limits), limits);
}
