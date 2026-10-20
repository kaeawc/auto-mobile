import { z } from "zod";
import { savedPrototypeAssetPath } from "../savedPrototypeLayout";
import { prototypeAssetIdProblem } from "../prototypeAssets";
import { BUNDLE_ASSET_LIMITS } from "./bundleLimits";
import { bundleAssert, PrototypeBundleError } from "./bundleErrors";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const recordSchema = z
  .object({
    id: z.string().refine((id) => !prototypeAssetIdProblem(id)),
    file: z.string(),
    sha256: sha,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"]),
  })
  .strict();
export const bundleManifestSchema = z
  .object({
    bundleFormatVersion: z.literal(1),
    specSha256: sha,
    assets: z.array(recordSchema).max(BUNDLE_ASSET_LIMITS.MAX_PROTOTYPE_ASSET_COUNT),
    fonts: z.array(recordSchema).max(BUNDLE_ASSET_LIMITS.MAX_PROTOTYPE_ASSET_COUNT),
    // Advisory capabilities; importers still validate their local capabilities.
    requires: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/))
      .max(BUNDLE_ASSET_LIMITS.MAX_PROTOTYPE_ASSET_COUNT),
  })
  .strict();
export type BundleManifest = z.infer<typeof bundleManifestSchema>;
export type BundleManifestAsset = BundleManifest["assets"][number];
export function bundleAssetPath(mediaType: BundleManifestAsset["mediaType"], hash: string): string {
  return savedPrototypeAssetPath(mediaType, hash);
}
export function parseBundleManifest(value: unknown): BundleManifest {
  const parsed = bundleManifestSchema.safeParse(value);
  bundleAssert(parsed.success, "manifest_invalid", "bundle.json");
  const manifest = parsed.data;
  const records = [...manifest.assets, ...manifest.fonts];
  bundleAssert(
    records.length <= BUNDLE_ASSET_LIMITS.MAX_PROTOTYPE_ASSET_COUNT,
    "manifest_invalid",
    "bundle.json",
  );
  const ids = new Set<string>();
  for (const item of records) {
    const inFonts = manifest.fonts.includes(item);
    bundleAssert(
      !ids.has(item.id) &&
        inFonts === item.mediaType.startsWith("font/") &&
        item.file === bundleAssetPath(item.mediaType, item.sha256),
      "manifest_invalid",
      "bundle.json",
    );
    ids.add(item.id);
  }
  bundleAssert(
    new Set(manifest.requires).size === manifest.requires.length,
    "manifest_invalid",
    "bundle.json",
  );
  return manifest;
}
export function parseBundleJson(text: string, entry: "bundle.json" | "spec.json"): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PrototypeBundleError(
      entry === "bundle.json" ? "manifest_invalid" : "spec_invalid",
      entry,
      error instanceof Error ? error.message : "Invalid JSON",
    );
  }
}
