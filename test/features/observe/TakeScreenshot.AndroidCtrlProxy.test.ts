import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { mockDevice } from "./takeScreenshotTestHelpers";

describe("TakeScreenshot Android CtrlProxy and fallback paths", function () {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "am-shot-test-"));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("tracks WebP metadata when requested", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(fakeAdb),
      undefined,
      undefined,
      undefined,
      undefined,
      () => cacheDir,
    );
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({ success: false, error: "CtrlProxy unavailable" }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    fakeAdb.setDefaultResponse({
      stdout: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
      stderr: "",
    });
    try {
      const result = await screenshot.execute({ format: "webp" });
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.webp$/);
      expect(result.screenshotFormat).toBe("webp");
      expect(result.screenshotMimeType).toBe("image/webp");
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("persists native Android CtrlProxy JPEG as jpg with metadata", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(fakeAdb),
      undefined,
      undefined,
      undefined,
      undefined,
      () => cacheDir,
    );
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({
        success: true,
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
        format: "jpeg",
      }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const result = await screenshot.execute({ format: "jpeg" });
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.jpg$/);
      expect(result.screenshotFormat).toBe("jpeg");
      expect(result.screenshotMimeType).toBe("image/jpeg");
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("captures requested PNG on the selected Android display through screencap", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(fakeAdb),
      undefined,
      undefined,
      undefined,
      undefined,
      () => cacheDir,
      new FakeAndroidPhysicalDisplayIdResolver(new Map([[2, "4619827259835644673"]])),
    );
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    let ctrlProxyCalled = false;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => {
        ctrlProxyCalled = true;
        return { success: false };
      },
    })) as typeof AndroidCtrlProxyClient.getInstance;
    fakeAdb.setDefaultResponse({
      stdout: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
      stderr: "",
    });
    try {
      const result = await screenshot.execute({ format: "png", displayId: 2 });
      expect(result.success).toBe(true);
      expect(result.screenshotFormat).toBe("png");
      expect(result.path).toMatch(/\.png$/);
      expect(ctrlProxyCalled).toBe(false);
      expect(
        fakeAdb.getExecutedCommands().find((command) => command.includes("screencap")),
      ).toContain("screencap -d 4619827259835644673 -p");
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("keeps the ADB fallback as PNG", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(fakeAdb),
      undefined,
      undefined,
      undefined,
      undefined,
      () => cacheDir,
    );
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({ success: false, error: "CtrlProxy unavailable" }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    fakeAdb.setDefaultResponse({
      stdout: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
      stderr: "",
    });
    try {
      const result = await screenshot.execute({});
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.png$/);
      expect(result.screenshotFormat).toBe("png");
      expect(result.screenshotMimeType).toBe("image/png");
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("should use single optimized ADB command for screenshot capture", async function () {
    const testFakeAdb = new FakeAdbExecutor();
    testFakeAdb.setDefaultResponse({
      stdout: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
      stderr: "",
    });
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(testFakeAdb),
      undefined,
      undefined,
      undefined,
      undefined,
      () => cacheDir,
    );
    (screenshot as any).window = { getActiveHash: async () => "mock-hash" };
    const result = await screenshot.execute();
    const executedCommands = testFakeAdb.getExecutedCommands();
    const captureCommand = executedCommands.find((command) => command.includes("screencap"));
    expect(captureCommand).toMatch(/screencap -p \/data\/local\/tmp\/am-shot-/);
    expect(captureCommand).toContain("base64");
    expect(captureCommand).toContain("rm");
    expect(result.success).toBe(true);
  });
});
