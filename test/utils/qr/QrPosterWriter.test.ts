import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import type { QrPngEncoder } from "../../../src/utils/qr/QrPngRenderer";
import { FileQrPosterWriter } from "../../../src/utils/qr/QrPosterWriter";
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
  async writeFileBuffer(filePath: string, data: Buffer): Promise<void> {
    this.files.set(filePath, data);
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
    const path = await writer.writePoster("01234567");
    expect(path).toMatch(/^\/data\/camera-posters\/qr-[0-9a-f]{16}\.png$/);
    expect(fileSystem.dirs).toEqual(["/data/camera-posters"]);
    expect(fileSystem.files.get(path)?.toString()).toBe("png-bytes");
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
});
