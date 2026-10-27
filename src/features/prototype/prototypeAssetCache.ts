import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { getTempDir } from "../../utils/tempDir";
import { MAX_PROTOTYPE_ASSET_TOTAL_BYTES, type PrototypeAssetUpload } from "./prototypeAssets";
import { disk, segment, type MirrorFileSystem } from "./savedPrototypeMirror";

export interface PrototypeAssetCache {
  put(serial: string, upload: PrototypeAssetUpload): Promise<void>;
  get(serial: string, id: string): Promise<PrototypeAssetUpload | undefined>;
  ids(serial: string): Promise<ReadonlySet<string>>;
  remove(serial: string, id: string): Promise<void>;
}
export const DEFAULT_PROTOTYPE_ASSET_CACHE_MAX_BYTES = 4 * MAX_PROTOTYPE_ASSET_TOTAL_BYTES;
const indexSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z
        .object({
          id: z.string(),
          mimeType: z.enum([
            "image/png",
            "image/jpeg",
            "image/webp",
            "font/ttf",
            "font/otf",
            "application/vnd.automobile.agsl",
          ]),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative(),
          usedAt: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict();
type Entry = z.infer<typeof indexSchema>["entries"][number];
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function referencedBytes(entries: Entry[]): number {
  return [...new Map(entries.map((entry) => [entry.sha256, entry.size])).values()].reduce(
    (sum, size) => sum + size,
    0,
  );
}

/** Per-device content-addressed cache; callers receive I/O failures without poisoning the queue. */
export class FilePrototypeAssetCache implements PrototypeAssetCache {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly files: MirrorFileSystem = disk,
    private readonly rootDir: () => string = () => getTempDir("prototype-asset-cache"),
    private readonly now: () => number = Date.now,
    private readonly maxBytes = DEFAULT_PROTOTYPE_ASSET_CACHE_MAX_BYTES,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    // The caller receives the rejection; subsequent operations can still run.
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async readIndex(directory: string): Promise<Entry[]> {
    let bytes: Uint8Array;
    try {
      bytes = await this.files.readFile(path.posix.join(directory, "index.json"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // A new device has no index until the first successful put.
        logger.debug("[PROTOTYPE] Asset cache index does not exist yet", error);
        return [];
      }
      logger.warn("[PROTOTYPE] Cannot read prototype asset cache index", error);
      throw error;
    }
    try {
      return indexSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).entries;
    } catch (error) {
      logger.warn("[PROTOTYPE] Invalid prototype asset cache index", error);
      return [];
    }
  }

  private async writeIndex(directory: string, entries: Entry[]): Promise<void> {
    await this.files.mkdir(directory);
    const stage = path.posix.join(directory, `index.json.${this.idGenerator.next()}.tmp`);
    await this.files.writeFile(stage, JSON.stringify(indexSchema.parse({ version: 1, entries })));
    await this.files.rename(stage, path.posix.join(directory, "index.json"));
  }
  private async cleanBlobs(directory: string, entries: Entry[]): Promise<void> {
    const blobs = path.posix.join(directory, "blobs");
    await this.files.mkdir(blobs);
    const referenced = new Set(entries.map((entry) => entry.sha256));
    for (const blob of await this.files.sortedReaddirEntries(blobs)) {
      if (!referenced.has(blob.name)) {
        await this.files.rm(path.posix.join(blobs, blob.name));
      }
    }
  }
  put(serial: string, upload: PrototypeAssetUpload): Promise<void> {
    // Detach bytes before joining the queue; caller mutation cannot change the cached upload.
    const snapshot = { ...upload, bytes: Uint8Array.from(upload.bytes) };
    return this.serialize(async () => {
      if (snapshot.bytes.length > this.maxBytes) {
        logger.warn(`[PROTOTYPE] Asset ${snapshot.id} exceeds prototype asset cache byte limit`);
        return;
      }
      const directory = path.posix.join(this.rootDir(), segment(serial));
      const entries = (await this.readIndex(directory)).filter((entry) => entry.id !== snapshot.id);
      const hash = sha256(snapshot.bytes);
      entries.push({
        id: snapshot.id,
        mimeType: snapshot.mimeType,
        sha256: hash,
        size: snapshot.bytes.length,
        usedAt: this.now(),
      });
      while (referencedBytes(entries) > this.maxBytes) {
        let oldest = -1;
        for (const [index, entry] of entries.entries()) {
          if (entry.sha256 !== hash && (oldest === -1 || entry.usedAt < entries[oldest].usedAt)) {
            oldest = index;
          }
        }
        if (oldest === -1) {
          break;
        }
        entries.splice(oldest, 1);
      }
      const blobs = path.posix.join(directory, "blobs");
      await this.files.mkdir(blobs);
      const existing = await this.files.sortedReaddirEntries(blobs);
      if (!existing.some((blob) => blob.name === hash)) {
        const destination = path.posix.join(blobs, hash);
        const stage = `${destination}.${this.idGenerator.next()}.tmp`;
        await this.files.writeFile(stage, snapshot.bytes);
        await this.files.rename(stage, destination);
      }
      await this.writeIndex(directory, entries);
      await this.cleanBlobs(directory, entries);
    });
  }
  get(serial: string, id: string): Promise<PrototypeAssetUpload | undefined> {
    return this.serialize(async () => {
      const directory = path.posix.join(this.rootDir(), segment(serial));
      const entries = await this.readIndex(directory);
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) {
        return undefined;
      }
      let bytes: Uint8Array;
      try {
        bytes = await this.files.readFile(path.posix.join(directory, "blobs", entry.sha256));
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
          throw new Error("Asset cache blob does not match its content hash or size");
        }
      } catch (error) {
        logger.warn(`[PROTOTYPE] Cached asset unavailable: ${serial}/${id}`, error);
        const remaining = entries.filter((candidate) => candidate.id !== id);
        try {
          await this.writeIndex(directory, remaining);
          await this.cleanBlobs(directory, remaining);
        } catch (cleanupError) {
          logger.warn(
            `[PROTOTYPE] Failed to clean unavailable cached asset: ${serial}/${id}`,
            cleanupError,
          );
        }
        return undefined;
      }
      entry.usedAt = this.now();
      try {
        await this.writeIndex(directory, entries);
      } catch (error) {
        logger.warn(`[PROTOTYPE] Failed to persist cached asset recency: ${serial}/${id}`, error);
      }
      return { id, mimeType: entry.mimeType, bytes };
    });
  }
  ids(serial: string): Promise<ReadonlySet<string>> {
    return this.serialize(
      async () =>
        new Set(
          (await this.readIndex(path.posix.join(this.rootDir(), segment(serial)))).map(
            (entry) => entry.id,
          ),
        ),
    );
  }
  remove(serial: string, id: string): Promise<void> {
    return this.serialize(async () => {
      const directory = path.posix.join(this.rootDir(), segment(serial));
      const entries = (await this.readIndex(directory)).filter((entry) => entry.id !== id);
      await this.writeIndex(directory, entries);
      await this.cleanBlobs(directory, entries);
    });
  }
}
let defaultCache: PrototypeAssetCache | undefined;
export function defaultPrototypeAssetCache(): PrototypeAssetCache {
  return (defaultCache ??= new FilePrototypeAssetCache());
}
