import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { mockDevice } from "./takeScreenshotTestHelpers";

describe("TakeScreenshot Android CtrlProxy and fallback paths", function () {
  test("tracks WebP metadata when requested", async function () {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, new FakeAdbClientFactory(fakeAdb));
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
    const screenshot = new TakeScreenshot(mockDevice, new FakeAdbClientFactory(fakeAdb));
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({
        success: true,
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
        format: "jpeg",
      }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const result = await screenshot.execute({});
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.jpg$/);
      expect(result.screenshotFormat).toBe("jpeg");
      expect(result.screenshotMimeType).toBe("image/jpeg");
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("keeps the ADB fallback as PNG", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(mockDevice, new FakeAdbClientFactory(fakeAdb));
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({ success: false, error: "CtrlProxy unavailable" }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    fakeAdb.setDefaultResponse({ stdout: Buffer.from("png bytes").toString("base64"), stderr: "" });
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
      stdout: Buffer.from("fake-png-data").toString("base64"),
      stderr: "",
    });
    const screenshot = new TakeScreenshot(mockDevice, new FakeAdbClientFactory(testFakeAdb));
    (screenshot as any).window = { getActiveHash: async () => "mock-hash" };
    const result = await screenshot.execute();
    const executedCommands = testFakeAdb.getExecutedCommands();
    expect(executedCommands.length).toBe(1);
    expect(executedCommands[0]).toContain("screencap");
    expect(executedCommands[0]).toContain("base64");
    expect(executedCommands[0]).toContain("rm");
    expect(result.success).toBe(true);
  });
});
