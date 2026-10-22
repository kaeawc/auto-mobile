import { createHash } from "node:crypto";
import { z } from "zod";
import {
  detectFontMimeType,
  isPrototypeFontMimeType,
  prototypeAssetIdProblem,
  type PrototypeAssetMimeType,
} from "../prototypeAssets";
import { savedPrototypeAssetPath } from "../savedPrototypeLayout";
import { parseBundleJson } from "./bundleJson";
import { bundleAssert } from "./bundleContract";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const assetSchema = z
  .object({
    id: z.string().refine((id) => prototypeAssetIdProblem(id) === null),
    file: z.string(),
    sha256: sha,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"]),
  })
  .strict();
const manifestSchema = z
  .object({
    bundleFormatVersion: z.literal(1),
    specSha256: sha,
    assets: z.array(assetSchema),
    fonts: z.array(assetSchema),
    requires: z.unknown(),
  })
  .strict();
export type BundleManifestAsset = z.infer<typeof assetSchema>;
export interface BundleManifest extends Omit<z.infer<typeof manifestSchema>, "requires"> {
  requires: string[];
}
export function bundleSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function parseBundleManifest(bytes: Uint8Array): BundleManifest {
  const parsed = manifestSchema.safeParse(
    parseBundleJson(bytes, "manifest_invalid", "bundle.json"),
  );
  bundleAssert(parsed.success, "manifest_invalid", "bundle.json");
  const manifest = parsed.data;
  const requires = z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).safeParse(manifest.requires);
  bundleAssert(requires.success, "requires_invalid", "bundle.json");
  bundleAssert(
    requires.data.every((name, index, all) => index === 0 || all[index - 1] < name),
    "requires_invalid",
    "bundle.json",
  );
  const ids = new Set<string>();
  for (const [entries, font] of [
    [manifest.assets, false],
    [manifest.fonts, true],
  ] as const) {
    for (const entry of entries) {
      bundleAssert(!ids.has(entry.id), "manifest_invalid", entry.id);
      ids.add(entry.id);
      bundleAssert(
        isPrototypeFontMimeType(entry.mediaType) === font,
        "manifest_invalid",
        entry.file,
      );
      bundleAssert(
        entry.file === savedPrototypeAssetPath(entry.mediaType, entry.sha256),
        "manifest_invalid",
        entry.file,
      );
    }
  }
  return { ...manifest, requires: requires.data };
}
export function bundleAssetTypeMatches(type: PrototypeAssetMimeType, bytes: Uint8Array): boolean {
  if (isPrototypeFontMimeType(type)) {
    return detectFontMimeType(bytes) === type;
  }
  const data = Buffer.from(bytes);
  if (type === "image/png") {
    return (
      data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  if (type === "image/jpeg") {
    return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  }
  return (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  );
}
