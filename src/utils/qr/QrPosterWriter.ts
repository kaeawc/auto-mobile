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
import { encodeQr } from "./QrEncoder";
import { JimpQrPngEncoder, renderQrPng, type QrPngEncoder } from "./QrPngRenderer";

/** Produces a host image path for a QR payload. */
export interface QrPosterWriter {
  writePoster(text: string): Promise<string>;
}

export const CAMERA_POSTER_SUBDIRECTORY = "camera-posters";

export interface FileQrPosterWriterOptions {
  fileSystem?: Pick<FileSystem, "ensureDir" | "writeFileBuffer">;
  pngEncoder?: QrPngEncoder;
  /** Resolved lazily so an AUTOMOBILE_DATA_DIR override is honored. */
  directory?: () => string;
}

export class FileQrPosterWriter implements QrPosterWriter {
  private readonly fileSystem: Pick<FileSystem, "ensureDir" | "writeFileBuffer">;
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
    return filePath;
  }
}
