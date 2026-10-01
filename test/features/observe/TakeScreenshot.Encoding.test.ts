import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Image } from "../../../src/utils/image-utils";
import { detectImageMimeType } from "../../../src/utils/screenshot/imageHeaderDimensions";
import {
  TakeScreenshot,
  replaceScreenshotExtension,
} from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { ScreenshotFileWriter } from "../../../src/features/observe/screenshot/ScreenshotFileWriter";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { screenshotFileName } from "../../../src/utils/screenshot/screenshotFormats";
import { iosDevice, mockDevice } from "./takeScreenshotTestHelpers";

const png = readFileSync("test/fixtures/screenshots/black-on-white.png");

class RecordingWriter implements ScreenshotFileWriter {
  readonly files = new Map<string, Buffer>();
  async write(filePath: string, data: Buffer): Promise<void> {
    this.files.set(filePath, data);
  }
  async remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

beforeAll(async () => {
  // Warm the lazy native image backend outside the unit-test timing budget.
  await Image.fromBuffer(png).jpeg({ quality: 70 }).disableCache().toBuffer();
});

describe("screenshot encoding and truthful metadata", () => {
  test("omitted format preserves native Android CtrlProxy JPEG bytes", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34]);
    const adb = new FakeAdbExecutor();
    const writer = new RecordingWriter();
    const original = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({
        success: true,
        format: "jpeg",
        data: jpeg.toString("base64"),
      }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const shot = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(adb),
        new FakeTimer(),
        new CountingIdGenerator("shot"),
        writer,
      );
      for (const options of [{}, { format: undefined }]) {
        const result = await shot.execute(options);
        expect(result.path).toEndWith(".jpg");
        expect(result.screenshotFormat).toBe("jpeg");
        expect(result.screenshotMimeType).toBe("image/jpeg");
        expect(writer.files.get(result.path ?? "")).toEqual(jpeg);
      }
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      AndroidCtrlProxyClient.getInstance = original;
    }
  });

  test("omitted format preserves ADB PNG bytes through direct and file-pull fallback", async () => {
    const original = AndroidCtrlProxyClient.getInstance;
    let ctrlProxyCalls = 0;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => {
        ctrlProxyCalls++;
        return { success: false, error: "unavailable" };
      },
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const directAdb = new FakeAdbExecutor();
      directAdb.setDefaultResponse({ stdout: png.toString("base64"), stderr: "" });
      const directWriter = new RecordingWriter();
      const direct = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(directAdb),
        new FakeTimer(),
        new CountingIdGenerator("direct"),
        directWriter,
      );
      const directResult = await direct.execute({});
      expect(directResult.path).toEndWith(".png");
      expect(directResult.screenshotFormat).toBe("png");
      expect(directResult.screenshotMimeType).toBe("image/png");
      expect(directWriter.files.get(directResult.path ?? "")).toEqual(png);
      expect(ctrlProxyCalls).toBe(1);

      const noArgWriter = new RecordingWriter();
      const noArg = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(directAdb),
        new FakeTimer(),
        new CountingIdGenerator("noarg"),
        noArgWriter,
      );
      const noArgResult = await noArg.execute();
      expect(noArgResult.path).toEndWith(".png");
      expect(noArgResult.screenshotMimeType).toBe("image/png");
      expect(noArgWriter.files.get(noArgResult.path ?? "")).toEqual(png);
      expect(ctrlProxyCalls).toBe(1);

      const pullAdb = new FakeAdbExecutor();
      pullAdb.setCommandError("base64", new Error("maxBuffer exceeded"));
      pullAdb.setCommandResponse("AM_SCREENCAP_RC", { stdout: "AM_SCREENCAP_RC:0", stderr: "" });
      const fileSystem = new FakeFileSystem();
      const pullWriter = new RecordingWriter();
      const pull = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(pullAdb),
        new FakeTimer(),
        new CountingIdGenerator("pull"),
        pullWriter,
        fileSystem,
        () => "/screenshots",
      );
      const expectedPath = path.join(
        path.dirname(pull.generateScreenshotPath(0, {})),
        screenshotFileName(0, mockDevice.deviceId, "pull-2", "png"),
      );
      fileSystem.setBinaryFile(`${expectedPath}.temp`, png);
      const pullResult = await pull.execute({});
      expect(pullResult.path).toBe(expectedPath);
      expect(pullResult.screenshotFormat).toBe("png");
      expect(pullResult.screenshotMimeType).toBe("image/png");
      expect(await fileSystem.readFileBuffer(expectedPath)).toEqual(png);
      expect(pullWriter.files.size).toBe(0);
    } finally {
      AndroidCtrlProxyClient.getInstance = original;
    }
  });

  test("no options preserve raw iOS CtrlProxy PNG bytes", async () => {
    const writer = new RecordingWriter();
    const original = IOSCtrlProxyClient.getInstance;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: async () => ({ success: true, data: png.toString("base64") }),
    })) as typeof IOSCtrlProxyClient.getInstance;
    try {
      const shot = new TakeScreenshot(
        iosDevice("ios-raw"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("shot"),
        writer,
      );
      for (const options of [undefined, {}]) {
        const result = await shot.execute(options);
        expect(result.path).toEndWith(".png");
        expect(result.screenshotFormat).toBe("png");
        expect(result.screenshotMimeType).toBe("image/png");
        expect(writer.files.get(result.path ?? "")).toEqual(png);
      }
    } finally {
      IOSCtrlProxyClient.getInstance = original;
    }
  });

  test("rejects contradictory options before any device request", async () => {
    const adb = new FakeAdbExecutor();
    const shot = new TakeScreenshot(mockDevice, new FakeAdbClientFactory(adb));
    const result = await shot.execute({ format: "webp", quality: 80, lossless: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid screenshot options");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("ADB fallback encodes requested JPEG quality and writes through the secure writer seam", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDefaultResponse({ stdout: png.toString("base64"), stderr: "" });
    const writer = new RecordingWriter();
    const original = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({ success: false }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const shot = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(adb),
        new FakeTimer(),
        new CountingIdGenerator("shot"),
        writer,
      );
      const result = await shot.execute({ format: "jpeg", quality: 70 });
      expect(result.success).toBe(true);
      expect(result.path).toEndWith(".jpg");
      expect(result.screenshotFormat).toBe("jpeg");
      expect(result.screenshotMimeType).toBe("image/jpeg");
      expect(detectImageMimeType(writer.files.get(result.path ?? "") ?? Buffer.alloc(0))).toBe(
        "image/jpeg",
      );
    } finally {
      AndroidCtrlProxyClient.getInstance = original;
    }
  });

  test("CtrlProxy MIME mismatch and an extensionless target use the detected bytes", async () => {
    const writer = new RecordingWriter();
    const original = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({
        success: true,
        format: "jpeg",
        data: png.toString("base64"),
      }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const shot = new TakeScreenshot(
        mockDevice,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("shot"),
        writer,
      );
      const result = await shot.execute({ format: "jpeg" });
      expect(result.path).toEndWith(".png");
      expect(result.screenshotFormat).toBe("png");
      expect(result.screenshotMimeType).toBe("image/png");
      expect(writer.files.get(result.path ?? "")).toEqual(png);
      expect(replaceScreenshotExtension("/tmp/capture", "png")).toBe("/tmp/capture.png");
    } finally {
      AndroidCtrlProxyClient.getInstance = original;
    }
  });

  test("iOS converts captured PNG to requested WebP and reports the saved format", async () => {
    const writer = new RecordingWriter();
    const original = IOSCtrlProxyClient.getInstance;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: async () => ({ success: true, data: png.toString("base64") }),
    })) as typeof IOSCtrlProxyClient.getInstance;
    try {
      const shot = new TakeScreenshot(
        iosDevice("ios-encoding"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("shot"),
        writer,
      );
      const result = await shot.execute({ format: "webp", lossless: true });
      expect(result.success).toBe(true);
      expect(result.path).toEndWith(".webp");
      expect(result.screenshotFormat).toBe("webp");
      expect(result.screenshotMimeType).toBe("image/webp");
      expect(detectImageMimeType(writer.files.get(result.path ?? "") ?? Buffer.alloc(0))).toBe(
        "image/webp",
      );
    } finally {
      IOSCtrlProxyClient.getInstance = original;
    }
  });
});
