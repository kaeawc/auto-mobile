import contract from "../../../../schemas/prototype-asset-contract.json";
import { MAX_PROTOTYPE_SPEC_BYTES } from "../prototypeSpec";
import { bundleAssert } from "./bundleErrors";

const asset = contract.limits;
// All transport allowances derive from the shared asset contract. The spec also retains
// its existing, tighter contract cap. Two metadata entries plus two reserved slots = 36.
export const MAX_BUNDLE_ENTRIES = asset.MAX_PROTOTYPE_ASSET_COUNT + 4;
export const MAX_BUNDLE_MANIFEST_BYTES =
  asset.MAX_PROTOTYPE_FONT_ASSET_BYTES / asset.MAX_PROTOTYPE_ASSET_COUNT;
export const MAX_BUNDLE_SPEC_BYTES = Math.min(
  MAX_PROTOTYPE_SPEC_BYTES,
  asset.MAX_PROTOTYPE_ASSET_BYTES / 4,
);
export const MAX_BUNDLE_EXPANDED_BYTES =
  asset.MAX_PROTOTYPE_ASSET_TOTAL_BYTES + MAX_BUNDLE_SPEC_BYTES + MAX_BUNDLE_MANIFEST_BYTES;
// Longest ASCII name: assets/ + SHA-256 hex + .webp. ZIP32 headers: 30 + 46, EOCD: 22.
export const MAX_BUNDLE_NAME_BYTES = "assets/".length + 64 + ".webp".length;
export const MAX_BUNDLE_COMPRESSED_BYTES =
  MAX_BUNDLE_EXPANDED_BYTES + MAX_BUNDLE_ENTRIES * (30 + 46 + 2 * MAX_BUNDLE_NAME_BYTES) + 22;
export const MAX_BUNDLE_RATIO =
  asset.MAX_PROTOTYPE_ASSET_COUNT *
  (asset.MAX_PROTOTYPE_ASSET_BYTES / asset.MAX_PROTOTYPE_FONT_ASSET_BYTES);
export interface BundleLimits {
  maxEntries: number;
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxRatio: number;
}
export const BUNDLE_LIMITS: Readonly<BundleLimits> = Object.freeze({
  maxEntries: MAX_BUNDLE_ENTRIES,
  maxCompressedBytes: MAX_BUNDLE_COMPRESSED_BYTES,
  maxExpandedBytes: MAX_BUNDLE_EXPANDED_BYTES,
  maxRatio: MAX_BUNDLE_RATIO,
});
/** Test/consumer limits may only tighten the production contract. */
export function resolveBundleLimits(overrides: Partial<BundleLimits> = {}): BundleLimits {
  const limits = { ...BUNDLE_LIMITS, ...overrides };
  for (const key of Object.keys(BUNDLE_LIMITS) as (keyof BundleLimits)[]) {
    bundleAssert(
      Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= BUNDLE_LIMITS[key],
      "limits_invalid",
    );
  }
  return limits;
}
export function entryExpandedCap(name: string): number {
  if (name === "spec.json") {
    return MAX_BUNDLE_SPEC_BYTES;
  }
  if (name === "bundle.json") {
    return MAX_BUNDLE_MANIFEST_BYTES;
  }
  return name.startsWith("fonts/")
    ? asset.MAX_PROTOTYPE_FONT_ASSET_BYTES
    : asset.MAX_PROTOTYPE_ASSET_BYTES;
}
export const BUNDLE_ASSET_LIMITS = asset;
