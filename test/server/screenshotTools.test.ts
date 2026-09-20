import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenshotOptions } from "../../src/features/observe/TakeScreenshot";
import type { BootedDevice } from "../../src/models";
import type { ScreenshotResult } from "../../src/models/ScreenshotResult";
import {
  captureScreenshotSchema,
  registerScreenshotTools,
  type ScreenshotToolsDependencies,
} from "../../src/server/screenshotTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type {
  ScreenshotJobHandle,
  ScreenshotJobOptions,
} from "../../src/utils/ScreenshotJobTracker";
import { pathExists } from "../../src/utils/filesystem/DefaultFileSystem";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 9",
  platform: "android",
};

function captureScreenshotHandler() {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
    (registeredTool) => registeredTool.name === "captureScreenshot",
  );
  if (!tool?.deviceAwareHandler) {
    throw new Error("captureScreenshot tool not registered");
  }
  return tool.deviceAwareHandler;
}

function trackedResult(result: ScreenshotResult): ScreenshotJobHandle {
  const controller = new AbortController();
  return {
    jobId: "screenshot-job",
    promise: Promise.resolve(result),
    signal: controller.signal,
  };
}

describe("captureScreenshot", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("declares only the shared device-targeting input surface", () => {
    expect(Object.keys(captureScreenshotSchema.shape)).toEqual([
      "platform",
      "sessionUuid",
      "keepScreenAwake",
      "device",
      "deviceId",
    ]);
    expect(
      captureScreenshotSchema.safeParse({
        platform: "android",
        sessionUuid: "session-123",
        keepScreenAwake: true,
        device: "primary",
        deviceId: "emulator-5554",
      }).success,
    ).toBe(true);

    for (const field of [
      "selector",
      "region",
      "crop",
      "format",
      "quality",
      "imageDelivery",
      "waitFor",
      "project",
    ]) {
      expect(field in captureScreenshotSchema.shape).toBe(false);
    }
  });

  test("requests a queued PNG capture and returns only file metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "automobile-capture-screenshot-"));
    const screenshotPath = join(tempDir, "capture.png");
    let requestedOptions: ScreenshotOptions | undefined;
    let receivedTrackerOptions: ScreenshotJobOptions | undefined;
    const controller = new AbortController();
    try {
      const dependencies: ScreenshotToolsDependencies = {
        createScreenshotService: () => ({
          startTrackedCapture(options, trackerOptions) {
            requestedOptions = options;
            receivedTrackerOptions = trackerOptions;
            return {
              ...trackedResult({ success: true, path: screenshotPath }),
              promise: (async () => {
                await writeFile(screenshotPath, "PNG fixture");
                return { success: true, path: screenshotPath };
              })(),
            };
          },
        }),
        pathExists,
      };

      registerScreenshotTools(dependencies);
      const response = await captureScreenshotHandler()(device, {}, undefined, controller.signal);

      const expected = {
        success: true,
        deviceId: device.deviceId,
        platform: device.platform,
        path: screenshotPath,
        screenshotFormat: "png",
        screenshotMimeType: "image/png",
      };
      expect(requestedOptions).toEqual({ format: "png" });
      expect(receivedTrackerOptions).toEqual({
        parentSignal: controller.signal,
        queueAfterPending: true,
      });
      expect(await pathExists(screenshotPath)).toBe(true);
      expect(response.structuredContent).toEqual(expected);
      expect(response.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
      expect(JSON.stringify(response.structuredContent)).not.toContain("base64");
      expect(JSON.stringify(response.structuredContent)).not.toContain("blob");
      expect(response.content.every((content) => content.type === "text")).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("throws an actionable error when capture fails", async () => {
    registerScreenshotTools({
      createScreenshotService: () => ({
        startTrackedCapture: () => trackedResult({ success: false, error: "device disconnected" }),
      }),
      pathExists: async () => true,
    });

    await expect(captureScreenshotHandler()(device, {})).rejects.toThrow(
      "Screenshot capture failed for device emulator-5554: device disconnected",
    );
  });

  test("throws when the successful capture path is missing", async () => {
    registerScreenshotTools({
      createScreenshotService: () => ({
        startTrackedCapture: () => trackedResult({ success: true, path: "/tmp/missing.png" }),
      }),
      pathExists: async () => false,
    });

    await expect(captureScreenshotHandler()(device, {})).rejects.toThrow(
      "Screenshot capture succeeded for device emulator-5554 but the file is missing: /tmp/missing.png",
    );
  });
});
