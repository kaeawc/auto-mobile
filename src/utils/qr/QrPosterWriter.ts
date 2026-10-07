/**
 * Render a QR code to a PNG file the Android emulator can use as its
 * virtual-scene camera poster (`-virtualscene-poster`).
 *
 * The file name is derived from a hash of the payload, so the same payload
 * reuses one file and no randomness or clock is involved.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { DefaultFileSystem, type FileSystem } from "../filesystem/DefaultFileSystem";
import { getTempDir } from "../tempDir";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { encodeQr } from "./QrEncoder";
import { JimpQrPngEncoder, renderQrPng, type QrPngEncoder } from "./QrPngRenderer";

/** Produces a host image path for a QR payload. */
export interface QrPosterWriter {
  writePoster(text: string): Promise<string>;
}

export const CAMERA_POSTER_SUBDIRECTORY = "camera-posters";

/** Newest posters kept; older ones are pruned so the directory stays bounded. */
export const MAX_RETAINED_POSTERS = 16;

type PosterFileSystem = Pick<FileSystem, "ensureDir" | "writeFileBuffer"> &
  Partial<Pick<FileSystem, "readdir" | "stat" | "unlink">>;

export interface FileQrPosterWriterOptions {
  fileSystem?: PosterFileSystem;
  pngEncoder?: QrPngEncoder;
  /** Resolved lazily so an AUTOMOBILE_DATA_DIR override is honored. */
  directory?: () => string;
}

export class FileQrPosterWriter implements QrPosterWriter {
  private readonly fileSystem: PosterFileSystem;
  private readonly pngEncoder: QrPngEncoder;
  private readonly directory: () => string;

  constructor(options: FileQrPosterWriterOptions = {}) {
    this.fileSystem = options.fileSystem ?? new DefaultFileSystem();
    this.pngEncoder = options.pngEncoder ?? new JimpQrPngEncoder();
    this.directory = options.directory ?? (() => getTempDir(CAMERA_POSTER_SUBDIRECTORY));
  }

  async writePoster(text: string): Promise<string> {
    // Encode first so an oversized payload fails before touching the filesystem.
    const png = await renderQrPng(encodeQr(text), {}, this.pngEncoder);
    const directory = this.directory();
    const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    const filePath = path.join(directory, `qr-${digest}.png`);
    await this.fileSystem.ensureDir(directory);
    await this.fileSystem.writeFileBuffer(filePath, png);
    await this.prune(directory, filePath);
    return filePath;
  }

  /** Keep the newest posters (the one just written is always kept); best-effort. */
  private async prune(directory: string, keepPath: string): Promise<void> {
    const { readdir, stat, unlink } = this.fileSystem;
    if (!readdir || !stat || !unlink) {
      return;
    }
    try {
      const names = (await readdir.call(this.fileSystem, directory)).filter((name) =>
        /^qr-[0-9a-f]{16}\.png$/.test(name),
      );
      const entries = await Promise.all(
        names.map(async (name) => {
          const full = path.join(directory, name);
          return { full, mtimeMs: (await stat.call(this.fileSystem, full)).mtimeMs };
        }),
      );
      const stale = entries
        .filter((entry) => entry.full !== keepPath)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(MAX_RETAINED_POSTERS - 1);
      await Promise.all(stale.map((entry) => unlink.call(this.fileSystem, entry.full)));
    } catch (error) {
      // Pruning is best-effort; a leftover poster is harmless, so keep the launch going.
      logger.warn(`camera poster pruning failed: ${errorMessage(error)}`, error);
    }
  }
}
