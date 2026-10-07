import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import type { QrPngEncoder } from "../../../src/utils/qr/QrPngRenderer";
import { FileQrPosterWriter, MAX_RETAINED_POSTERS } from "../../../src/utils/qr/QrPosterWriter";
import { encodeQr } from "../../../src/utils/qr/QrEncoder";
import { rasterizeQr } from "../../../src/utils/qr/QrPngRenderer";

class RecordingEncoder implements QrPngEncoder {
  readonly images: RawImage[] = [];
  async encodePng(image: RawImage): Promise<Buffer> {
    this.images.push(image);
    return Buffer.from("png-bytes");
  }
}

class RecordingFileSystem {
  readonly dirs: string[] = [];
  readonly files = new Map<string, Buffer>();
  async ensureDir(dirPath: string): Promise<void> {
    this.dirs.push(dirPath);
  }
  readonly mtimes = new Map<string, number>();
  async writeFileBuffer(filePath: string, data: Buffer): Promise<void> {
    this.files.set(filePath, data);
    this.mtimes.set(filePath, this.mtimes.size + 1);
  }
  async readdir(): Promise<string[]> {
    return [...this.files.keys()].map((file) => path.basename(file));
  }
  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    return { size: 1, mtimeMs: this.mtimes.get(filePath) ?? 0 };
  }
  async unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

function makeWriter() {
  const fileSystem = new RecordingFileSystem();
  const pngEncoder = new RecordingEncoder();
  const writer = new FileQrPosterWriter({
    fileSystem,
    pngEncoder,
    directory: () => "/data/camera-posters",
  });
  return { fileSystem, pngEncoder, writer };
}

describe("FileQrPosterWriter", () => {
  test("renders the encoded matrix and writes it to a payload-derived png path", async () => {
    const { fileSystem, pngEncoder, writer } = makeWriter();
    const posterPath = await writer.writePoster("01234567");
    // path.join emits the host separator (backslash on Windows), so compare via path helpers.
    expect(path.dirname(posterPath)).toBe(path.join("/data", "camera-posters"));
    expect(path.basename(posterPath)).toMatch(/^qr-[0-9a-f]{16}\.png$/);
    expect(fileSystem.dirs).toEqual(["/data/camera-posters"]);
    expect(fileSystem.files.get(posterPath)?.toString()).toBe("png-bytes");
    expect(pngEncoder.images[0]).toEqual(rasterizeQr(encodeQr("01234567")));
  });

  test("same payload reuses one path and different payloads do not collide", async () => {
    const { writer } = makeWriter();
    const a = await writer.writePoster("alpha");
    expect(await writer.writePoster("alpha")).toBe(a);
    expect(await writer.writePoster("beta")).not.toBe(a);
  });

  test("an oversized payload fails before any filesystem write", async () => {
    const { fileSystem, writer } = makeWriter();
    await expect(writer.writePoster("x".repeat(500))).rejects.toBeInstanceOf(ActionableError);
    expect(fileSystem.dirs).toEqual([]);
    expect(fileSystem.files.size).toBe(0);
  });

  test("prunes the oldest posters beyond the retention bound and keeps the new one", async () => {
    const { fileSystem, writer } = makeWriter();
    const first = await writer.writePoster("p0");
    let last = first;
    for (let i = 1; i <= MAX_RETAINED_POSTERS + 3; i++) {
      last = await writer.writePoster(`p${i}`);
    }
    expect(fileSystem.files.size).toBe(MAX_RETAINED_POSTERS);
    expect(fileSystem.files.has(first)).toBe(false);
    expect(fileSystem.files.has(last)).toBe(true);
  });
});
