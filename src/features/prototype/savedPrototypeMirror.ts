import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { sortedReaddirEntries } from "../../utils/io";
import { getTempDir } from "../../utils/tempDir";
import { prototypeSpecSchema, type PrototypeSpec } from "./prototypeSpec";
import type { PrototypeAssetMimeType } from "./prototypeAssets";

export interface MirroredPrototypeAsset {
  id: string;
  mimeType?: PrototypeAssetMimeType;
  /** Absent when the host did not have this asset at save time, or its file is unreadable. */
  bytes?: Uint8Array;
}
export interface MirroredSavedPrototype {
  id: string;
  spec: PrototypeSpec;
  label: string;
  icon?: string;
  assets: MirroredPrototypeAsset[];
}
export interface SavedPrototypeMirror {
  record(serial: string, entry: MirroredSavedPrototype): Promise<void>;
  remove(serial: string, id: string): Promise<void>;
  list(serial: string): Promise<MirroredSavedPrototype[]>;
}
export interface MirrorFileSystem {
  mkdir(directory: string): Promise<void>;
  writeFile(file: string, data: string | Uint8Array): Promise<void>;
  readFile(file: string): Promise<Uint8Array>;
  sortedReaddirEntries(directory: string): Promise<Pick<Dirent, "name" | "isDirectory">[]>;
  rm(target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
const disk: MirrorFileSystem = {
  mkdir: async (directory) => {
    await fs.mkdir(directory, { recursive: true });
  },
  writeFile: (file, data) => fs.writeFile(file, data),
  readFile: (file) => fs.readFile(file),
  sortedReaddirEntries,
  rm: (target) => fs.rm(target, { recursive: true, force: true }),
  rename: (from, to) => fs.rename(from, to),
};
const assetSchema = z.union([
  z.object({ id: z.string().min(1), missing: z.literal(true) }).strict(),
  z
    .object({
      id: z.string().min(1),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"]),
      index: z.number().int().nonnegative().max(10000),
    })
    .strict(),
]);
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    spec: z.custom<PrototypeSpec>((value) => prototypeSpecSchema.safeParse(value).success),
    label: z.string().min(1),
    icon: z.string().optional(),
    assets: z.array(assetSchema),
  })
  .strict();

// Hash UTF-16 code units so even distinct unpaired surrogates stay distinct on every platform.
function segment(value: string): string {
  return `s-${createHash("sha256").update(value, "utf16le").digest("hex")}`;
}
function absent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class FileSavedPrototypeMirror implements SavedPrototypeMirror {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly files: MirrorFileSystem = disk,
    private readonly rootDir: () => string = () => getTempDir("saved-prototypes"),
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    // The operation's caller receives the rejection; it must not poison subsequent operations.
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  record(serial: string, entry: MirroredSavedPrototype): Promise<void> {
    return this.serialize(() => this.writeEntry(serial, entry));
  }
  private async writeEntry(serial: string, entry: MirroredSavedPrototype): Promise<void> {
    const directory = path.join(this.rootDir(), segment(serial));
    const target = path.join(directory, segment(entry.id));
    const token = segment(this.ids.next());
    const stage = path.join(directory, `.tmp-${token}`);
    const backup = path.join(directory, `.old-${token}`);
    try {
      await this.files.mkdir(path.join(stage, "assets"));
      const assets: z.infer<typeof assetSchema>[] = [];
      for (const [index, asset] of entry.assets.entries()) {
        if (asset.bytes === undefined || asset.mimeType === undefined) {
          assets.push({ id: asset.id, missing: true });
        } else {
          await this.files.writeFile(path.join(stage, "assets", `${index}.bin`), asset.bytes);
          assets.push({ id: asset.id, mimeType: asset.mimeType, index });
        }
      }
      const manifest = manifestSchema.parse({
        version: 1,
        id: entry.id,
        spec: entry.spec,
        label: entry.label,
        icon: entry.icon,
        assets,
      });
      await this.files.writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest));
      const replaced = (await this.files.sortedReaddirEntries(directory)).some(
        (item) => item.name === segment(entry.id),
      );
      if (replaced) {
        await this.files.rename(target, backup);
      }
      try {
        await this.files.rename(stage, target);
      } catch (error) {
        logger.warn(`[PROTOTYPE] Mirror replacement failed for ${entry.id}`, error);
        if (replaced) {
          await this.files.rename(backup, target);
        }
        throw error;
      }
      if (replaced) {
        await this.files.rm(backup);
      }
    } finally {
      try {
        await this.files.rm(stage);
      } catch (error) {
        logger.warn(`[PROTOTYPE] Could not clean mirror staging directory for ${entry.id}`, error);
      }
    }
  }
  remove(serial: string, id: string): Promise<void> {
    return this.serialize(() =>
      this.files.rm(path.join(this.rootDir(), segment(serial), segment(id))),
    );
  }
  list(serial: string): Promise<MirroredSavedPrototype[]> {
    return this.serialize(() => this.readEntries(serial));
  }
  private async readEntries(serial: string): Promise<MirroredSavedPrototype[]> {
    try {
      const directory = path.join(this.rootDir(), segment(serial));
      const entries: MirroredSavedPrototype[] = [];
      for (const item of await this.files.sortedReaddirEntries(directory)) {
        const { name } = item;
        if (
          !item.isDirectory() ||
          name.startsWith(".") ||
          name !== path.basename(name) ||
          name.includes("\\")
        ) {
          continue;
        }
        const entry = await this.readEntry(path.join(directory, name), name);
        if (entry) {
          entries.push(entry);
        }
      }
      return entries;
    } catch (error) {
      if (!absent(error)) {
        logger.warn(`[PROTOTYPE] Cannot list saved prototype mirror for ${serial}`, error);
      }
      return [];
    }
  }
  private async readEntry(
    directory: string,
    name: string,
  ): Promise<MirroredSavedPrototype | undefined> {
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            await this.files.readFile(path.join(directory, "manifest.json")),
          ),
        ),
      );
      if (segment(manifest.id) !== name) {
        throw new Error("Mirror id does not match directory");
      }
      const assets: MirroredPrototypeAsset[] = [];
      for (const asset of manifest.assets) {
        if ("missing" in asset) {
          assets.push({ id: asset.id });
          continue;
        }
        try {
          assets.push({
            id: asset.id,
            mimeType: asset.mimeType,
            bytes: await this.files.readFile(path.join(directory, "assets", `${asset.index}.bin`)),
          });
        } catch (error) {
          logger.warn(`[PROTOTYPE] Mirror asset unavailable: ${manifest.id}/${asset.id}`, error);
          assets.push({ id: asset.id, mimeType: asset.mimeType });
        }
      }
      return {
        id: manifest.id,
        spec: manifest.spec,
        label: manifest.label,
        ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
        assets,
      };
    } catch (error) {
      logger.warn(`[PROTOTYPE] Skipping unreadable saved prototype mirror entry ${name}`, error);
      return undefined;
    }
  }
}
let defaultMirror: SavedPrototypeMirror | undefined;
export function defaultSavedPrototypeMirror(): SavedPrototypeMirror {
  return (defaultMirror ??= new FileSavedPrototypeMirror());
}
export function missingOnDevice(
  mirrored: MirroredSavedPrototype[],
  deviceEntries: { id: string }[],
): MirroredSavedPrototype[] {
  const present = new Set(deviceEntries.map((entry) => entry.id));
  return mirrored.filter((entry) => !present.has(entry.id));
}
