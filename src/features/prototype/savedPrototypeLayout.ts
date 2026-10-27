import { createHash } from "node:crypto";
import { posix } from "node:path";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { MAX_PROTOTYPE_SPEC_BYTES } from "./prototypeSpec";
import { validatePrototypeSpec } from "./prototypeValidation";
import {
  type PrototypeAssetMimeType,
  isPrototypeFontMimeType,
  detectFontMimeType,
  prototypeAssetUploadProblem,
  prototypeAssetIdProblem,
  maxPrototypeAssetBytes,
  PROTOTYPE_ASSET_MIME_TYPES,
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
} from "./prototypeAssets";
import { NodeSavedPrototypeLayoutFileSystem } from "./NodeSavedPrototypeLayoutFileSystem";

// Simulator and prototype container paths are POSIX on every host OS.
const { dirname, join } = posix;

export const SAVED_PROTOTYPE_FORMAT_VERSION = 1;
const extensions: Record<PrototypeAssetMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/vnd.automobile.agsl": "agsl",
};
export function savedPrototypeAssetPath(mediaType: PrototypeAssetMimeType, sha256: string): string {
  return `${isPrototypeFontMimeType(mediaType) ? "fonts" : "assets"}/${sha256}.${extensions[mediaType]}`;
}
export interface SavedPrototypeManifestAsset {
  id: string;
  file: string;
  sha256: string;
  mediaType: PrototypeAssetMimeType;
}
export interface SavedPrototypeManifest {
  formatVersion: number;
  specFile: string;
  assets: SavedPrototypeManifestAsset[];
  fonts: SavedPrototypeManifestAsset[];
}
export interface SavedPrototypeLayoutRequest {
  specJson: string;
  assets: { id: string; mediaType: PrototypeAssetMimeType; bytes: Uint8Array }[];
}
export type SavedPrototypeLayoutRejection =
  | "INVALID_SPEC"
  | "SPEC_TOO_LARGE"
  | "INVALID_ASSET_ID"
  | "DUPLICATE_ASSET_ID"
  | "UNSUPPORTED_MIME_TYPE"
  | "EMPTY_ASSET"
  | "ASSET_TOO_LARGE"
  | "INVALID_FONT"
  | "COUNT_LIMIT"
  | "TOTAL_LIMIT"
  | "STORAGE_FAILURE";
export type SavedPrototypeLayoutWriteResult =
  | { kind: "written"; destination: string; replaced: boolean; manifest: SavedPrototypeManifest }
  | { kind: "rejected"; reason: SavedPrototypeLayoutRejection; message: string };
export interface SavedPrototypeLayoutWriter {
  write(
    request: SavedPrototypeLayoutRequest,
    destination: string,
  ): Promise<SavedPrototypeLayoutWriteResult>;
}
export interface SavedPrototypeLayoutFileSystem {
  ensureDir(path: string): Promise<void>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
function rejected(reason: SavedPrototypeLayoutRejection): SavedPrototypeLayoutWriteResult {
  return { kind: "rejected", reason, message: `Saved prototype rejected: ${reason}.` };
}
function assetRejection(
  asset: SavedPrototypeLayoutRequest["assets"][number],
): SavedPrototypeLayoutRejection | null {
  if (prototypeAssetIdProblem(asset.id)) {
    return "INVALID_ASSET_ID";
  }
  if (!PROTOTYPE_ASSET_MIME_TYPES.includes(asset.mediaType)) {
    return "UNSUPPORTED_MIME_TYPE";
  }
  if (asset.bytes.length === 0) {
    return "EMPTY_ASSET";
  }
  if (asset.bytes.length > maxPrototypeAssetBytes(asset.mediaType)) {
    return "ASSET_TOO_LARGE";
  }
  if (
    isPrototypeFontMimeType(asset.mediaType) &&
    detectFontMimeType(asset.bytes) !== asset.mediaType
  ) {
    return "INVALID_FONT";
  }
  return prototypeAssetUploadProblem({ ...asset, mimeType: asset.mediaType })
    ? "INVALID_FONT"
    : null;
}
function validate(request: SavedPrototypeLayoutRequest): SavedPrototypeLayoutRejection | null {
  if (Buffer.byteLength(request.specJson) > MAX_PROTOTYPE_SPEC_BYTES) {
    return "SPEC_TOO_LARGE";
  }
  if (!validatePrototypeSpec(request.specJson).success) {
    return "INVALID_SPEC";
  }
  if (request.assets.length > MAX_PROTOTYPE_ASSET_COUNT) {
    return "COUNT_LIMIT";
  }
  const ids = new Set<string>();
  let total = 0;
  for (const asset of request.assets) {
    const problem = assetRejection(asset);
    if (problem) {
      return problem;
    }
    if (ids.has(asset.id)) {
      return "DUPLICATE_ASSET_ID";
    }
    ids.add(asset.id);
    total += asset.bytes.length;
  }
  return total > MAX_PROTOTYPE_ASSET_TOTAL_BYTES ? "TOTAL_LIMIT" : null;
}
/** One iOS prototype, without Android slug metadata or required spec-reference completeness.
 * Owners must serialize writes to a destination. Staging and backup live on the same volume.
 */
export class DirectorySavedPrototypeLayoutWriter implements SavedPrototypeLayoutWriter {
  constructor(
    private readonly files: SavedPrototypeLayoutFileSystem = new NodeSavedPrototypeLayoutFileSystem(),
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async write(
    request: SavedPrototypeLayoutRequest,
    destination: string,
  ): Promise<SavedPrototypeLayoutWriteResult> {
    const problem = validate(request);
    if (problem) {
      return rejected(problem);
    }
    let stage: string | undefined;
    try {
      const token = this.ids.next();
      stage = join(dirname(destination), `.tmp-${token}`);
      const old = join(dirname(destination), `.old-${token}`);
      const manifest = await this.stage(request, stage);
      const replaced = await this.files.exists(destination);
      await this.commit(stage, old, destination, replaced);
      return { kind: "written", destination, replaced, manifest };
    } catch (error) {
      logger.warn("Failed to write saved prototype", error);
      if (stage) {
        await this.cleanup(stage);
      }
      return rejected("STORAGE_FAILURE");
    }
  }
  private async stage(
    request: SavedPrototypeLayoutRequest,
    stage: string,
  ): Promise<SavedPrototypeManifest> {
    await this.files.ensureDir(join(stage, "assets"));
    await this.files.ensureDir(join(stage, "fonts"));
    const manifest: SavedPrototypeManifest = {
      formatVersion: SAVED_PROTOTYPE_FORMAT_VERSION,
      specFile: "spec.json",
      assets: [],
      fonts: [],
    };
    const written = new Set<string>();
    for (const asset of request.assets) {
      const sha256 = createHash("sha256").update(asset.bytes).digest("hex");
      const file = savedPrototypeAssetPath(asset.mediaType, sha256);
      if (!written.has(file)) {
        await this.files.writeFile(join(stage, file), asset.bytes);
        written.add(file);
      }
      const list = isPrototypeFontMimeType(asset.mediaType) ? manifest.fonts : manifest.assets;
      list.push({ id: asset.id, file, sha256, mediaType: asset.mediaType });
    }
    await this.files.writeFile(join(stage, "spec.json"), Buffer.from(request.specJson));
    await this.files.writeFile(
      join(stage, "manifest.json"),
      Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    );
    return manifest;
  }
  private async commit(
    stage: string,
    old: string,
    destination: string,
    replaced: boolean,
  ): Promise<void> {
    if (replaced) {
      await this.files.rename(destination, old);
    }
    try {
      await this.files.rename(stage, destination);
    } catch (error) {
      logger.warn("Failed to commit saved prototype; restoring previous directory", error);
      if (replaced) {
        try {
          await this.files.rename(old, destination);
        } catch (restoreError) {
          logger.warn("Failed to restore saved prototype backup directory", restoreError);
        }
      }
      throw error;
    }
    try {
      await this.files.remove(old);
    } catch (error) {
      logger.warn("Failed to remove saved prototype backup directory", error);
    }
  }
  private async cleanup(path: string): Promise<void> {
    try {
      await this.files.remove(path);
    } catch (error) {
      logger.warn("Failed to clean saved prototype staging directory", error);
    }
  }
}
