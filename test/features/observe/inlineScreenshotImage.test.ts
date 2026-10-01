import { describe, expect, test } from "bun:test";
import {
  inlineScreenshotImage,
  MAX_INLINE_SCREENSHOT_BYTES,
  type ScreenshotImageFileSystem,
} from "../../../src/features/observe/screenshot/inlineScreenshotImage";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const webp = Buffer.from("RIFF1234WEBPdata");

class FakeScreenshotFileSystem implements ScreenshotImageFileSystem {
  statCalls = 0;
  readCalls = 0;
  size: number;
  statError?: Error;
  readError?: Error;
  onRead?: () => void;
  isFile = true;

  constructor(readonly bytes: Buffer) {
    this.size = bytes.length;
  }

  async stat(): Promise<{ size: number; isFile(): boolean }> {
    this.statCalls++;
    if (this.statError) {
      throw this.statError;
    }
    return { size: this.size, isFile: () => this.isFile };
  }

  async readFile(): Promise<Buffer> {
    this.readCalls++;
    this.onRead?.();
    if (this.readError) {
      throw this.readError;
    }
    return this.bytes;
  }
}

describe("inlineScreenshotImage", () => {
  test.each([
    [png, "image/png"],
    [jpeg, "image/jpeg"],
    [webp, "image/webp"],
  ])("returns exact captured bytes as %s", async (bytes, mimeType) => {
    const fs = new FakeScreenshotFileSystem(bytes);
    const delivery = await inlineScreenshotImage("/capture", {}, undefined, fs);
    expect(delivery).toEqual({
      image: { type: "image", data: bytes.toString("base64"), mimeType },
      screenshotImage: { included: true, mimeType, sizeBytes: bytes.length },
    });
    expect(fs.readCalls).toBe(1);
  });

  test("uses reported MIME type for both image content and status", async () => {
    const fs = new FakeScreenshotFileSystem(png);
    const delivery = await inlineScreenshotImage(
      "/capture.png",
      { screenshotFormat: "webp", screenshotMimeType: "image/webp" },
      undefined,
      fs,
    );
    expect(delivery.image?.mimeType).toBe("image/webp");
    expect(delivery.screenshotImage).toEqual({
      included: true,
      mimeType: "image/webp",
      sizeBytes: png.length,
    });
  });

  test("derives MIME type from reported format when only format is present", async () => {
    const fs = new FakeScreenshotFileSystem(png);
    const delivery = await inlineScreenshotImage(
      "/capture.png",
      { screenshotFormat: "jpeg" },
      undefined,
      fs,
    );
    expect(delivery.image?.mimeType).toBe("image/jpeg");
  });

  test("uses the file extension when bytes do not identify the format", async () => {
    const fs = new FakeScreenshotFileSystem(Buffer.from("opaque bytes"));
    const delivery = await inlineScreenshotImage("/capture.webp", {}, undefined, fs);
    expect(delivery.image?.mimeType).toBe("image/webp");
  });

  test("missing path returns status without file access", async () => {
    const fs = new FakeScreenshotFileSystem(png);
    const delivery = await inlineScreenshotImage(undefined, {}, undefined, fs);
    expect(delivery.screenshotImage).toMatchObject({
      included: false,
      reason: expect.stringContaining("no screenshot path"),
    });
    expect(fs.statCalls).toBe(0);
    expect(fs.readCalls).toBe(0);
  });

  test("over cap returns size and cap before reading", async () => {
    const fs = new FakeScreenshotFileSystem(png);
    fs.size = MAX_INLINE_SCREENSHOT_BYTES + 1;
    expect(
      (await inlineScreenshotImage("/capture", {}, undefined, fs)).screenshotImage,
    ).toMatchObject({
      included: false,
      sizeBytes: fs.size,
      capBytes: MAX_INLINE_SCREENSHOT_BYTES,
    });
    expect(fs.readCalls).toBe(0);
  });

  test("growth beyond cap returns size and cap", async () => {
    const bytes = png;
    const fs = new FakeScreenshotFileSystem(bytes);
    fs.size = 4;
    expect(
      (await inlineScreenshotImage("/capture", {}, undefined, fs, 8)).screenshotImage,
    ).toMatchObject({
      included: false,
      sizeBytes: bytes.length,
      capBytes: 8,
    });
  });

  test.each(["stat", "read"])("%s failure returns status", async (operation) => {
    const fs = new FakeScreenshotFileSystem(png);
    if (operation === "stat") {
      fs.statError = new Error("EACCES");
    } else {
      fs.readError = new Error("EACCES");
    }
    const delivery = await inlineScreenshotImage("/capture", {}, undefined, fs);
    expect(delivery.screenshotImage).toMatchObject({
      included: false,
      reason: expect.stringContaining("EACCES"),
    });
    expect(delivery.image).toBeUndefined();
  });

  test("non-file and unsupported bytes return status", async () => {
    const fs = new FakeScreenshotFileSystem(Buffer.from("not an image"));
    fs.isFile = false;
    expect(
      (await inlineScreenshotImage("/capture", {}, undefined, fs)).screenshotImage,
    ).toMatchObject({
      included: false,
      reason: expect.stringContaining("not a file"),
    });
    fs.isFile = true;
    expect(
      (await inlineScreenshotImage("/capture", {}, undefined, fs)).screenshotImage,
    ).toMatchObject({
      included: false,
      reason: expect.stringContaining("not a supported"),
    });
  });

  test("checks cancellation before and after read", async () => {
    const before = new AbortController();
    before.abort();
    const fs = new FakeScreenshotFileSystem(png);
    await expect(inlineScreenshotImage("/capture", {}, before.signal, fs)).rejects.toThrow();
    expect(fs.statCalls).toBe(0);

    const during = new AbortController();
    fs.onRead = () => during.abort();
    await expect(inlineScreenshotImage("/capture", {}, during.signal, fs)).rejects.toThrow();
    expect(fs.readCalls).toBe(1);
  });
});
