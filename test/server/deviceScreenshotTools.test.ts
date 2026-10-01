import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BootedDevice } from "../../src/models";
import type { ScreenshotResult } from "../../src/models/ScreenshotResult";
import type { TrackedScreenshotService } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import {
  captureDeviceScreenshot,
  captureDeviceScreenshotSchema,
  hasScreenshotAccess,
  registerDeviceScreenshotTool,
  type DeviceScreenshotDependencies,
} from "../../src/server/deviceScreenshotTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 9",
  platform: "android",
};

const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");
const maxScreenshotBytes = 16 * 1024 * 1024;
const args = captureDeviceScreenshotSchema.parse({ deviceId: device.deviceId });
const dirs: string[] = [];

async function imageFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-screenshot-test-"));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, png);
  await fs.utimes(file, 8, 8);
  return file;
}

function screenshotService(
  result: ScreenshotResult | Promise<ScreenshotResult>,
  onCapture?: () => void,
): TrackedScreenshotService {
  const controller = new AbortController();
  return {
    execute: async () => result,
    generateScreenshotPath: () => "unused",
    getActivityHash: async () => "unused",
    startTrackedCapture: (_options, trackerOptions) => {
      expect(trackerOptions?.queueAfterPending).toBe(true);
      onCapture?.();
      return { jobId: "fake", promise: Promise.resolve(result), signal: controller.signal };
    },
  };
}

function dependencies(
  timer: FakeTimer,
  result: ScreenshotResult | Promise<ScreenshotResult>,
  options: {
    cachedPath?: string;
    authorized?: (callerSessionUuid: string | undefined) => boolean;
    onCapture?: () => void;
  } = {},
): DeviceScreenshotDependencies {
  return {
    listBooted: async () => [device],
    isAuthorized: (_device, caller) => options.authorized?.(caller) ?? true,
    createScreenshotService: () => screenshotService(result, options.onCapture),
    cachedScreenshotPath: () => options.cachedPath,
    files: fs,
    timer,
  };
}

function fakeFiles(options: { isFile?: boolean; size: number; bytes?: Buffer; growing?: boolean }) {
  let reads = 0;
  let closes = 0;
  const files: DeviceScreenshotDependencies["files"] = {
    open: async () => ({
      stat: async () => ({
        isFile: () => options.isFile ?? true,
        size: options.size,
        mtimeMs: 8_000,
      }),
      read: async (buffer, offset, length, position) => {
        reads++;
        const available = options.growing
          ? maxScreenshotBytes + 1 - position
          : (options.bytes?.length ?? 0) - position;
        const bytesRead = Math.min(length, Math.max(0, available));
        if (options.bytes) {
          options.bytes.copy(buffer, offset, position, position + bytesRead);
        }
        return { bytesRead };
      },
      close: async () => {
        closes++;
      },
    }),
  };
  return {
    files,
    get reads() {
      return reads;
    },
    get closes() {
      return closes;
    },
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  ToolRegistry.unregister("captureDeviceScreenshot");
});

describe("captureDeviceScreenshot", () => {
  test("registers an explicit device-addressed tool", () => {
    registerDeviceScreenshotTool();
    const tool = ToolRegistry.getTool("captureDeviceScreenshot");
    expect(tool?.requiresDevice).toBe(false);
    expect(tool?.schema.parse({ deviceId: "emulator-5554" })).toEqual(args);
  });

  test("returns fresh pixels and metadata for an unowned device", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const freshPath = await imageFile("fresh.png");
    const result = await captureDeviceScreenshot(
      args,
      undefined,
      undefined,
      dependencies(
        timer,
        { success: true, path: freshPath },
        {
          authorized: (caller) => hasScreenshotAccess(undefined, caller, undefined),
        },
      ),
    );

    expect(result.structuredContent).toMatchObject({
      deviceId: device.deviceId,
      platform: "android",
      source: "fresh",
      captureSource: "device",
      mimeType: "image/png",
      ageMs: 2_000,
      width: 2,
      height: 3,
    });
    expect(result.content[1]).toMatchObject({ type: "image", data: png.toString("base64") });
  });

  test("returns fresh pixels when this MCP connection owns the device session", async () => {
    const freshPath = await imageFile("owned.png");
    const result = await captureDeviceScreenshot(
      args,
      "owner-session",
      undefined,
      dependencies(
        new FakeTimer(),
        { success: true, path: freshPath },
        {
          authorized: (caller) =>
            hasScreenshotAccess("owner-session", caller, (session) => session === "owner-session"),
        },
      ),
    );

    expect(result.structuredContent).toMatchObject({ source: "fresh" });
    expect(result.content[1]).toMatchObject({ type: "image" });
  });

  test("denies an unauthorized caller before capture or cached read", async () => {
    const timer = new FakeTimer();
    let captures = 0;
    let cacheReads = 0;
    const deps = dependencies(
      timer,
      { success: false },
      {
        authorized: (caller) => hasScreenshotAccess("other-session", caller, () => false),
        onCapture: () => captures++,
      },
    );
    deps.cachedScreenshotPath = () => {
      cacheReads++;
      return undefined;
    };

    const result = await captureDeviceScreenshot(args, "other-client", undefined, deps);

    expect(result.structuredContent).toEqual({
      error: {
        code: "SCREENSHOT_ACCESS_DENIED",
        message: "Screenshot access denied.",
        retryable: false,
      },
    });
    expect(captures).toBe(0);
    expect(cacheReads).toBe(0);
  });

  test("allows unowned devices and only the transport-bound owner of owned devices", () => {
    expect(hasScreenshotAccess("owner", "owner", undefined)).toBe(false);
    expect(hasScreenshotAccess("owner", "owner", () => false)).toBe(false);
    expect(hasScreenshotAccess("owner", "owner", () => true)).toBe(true);
    expect(hasScreenshotAccess("owner", "other", () => false)).toBe(false);
    expect(hasScreenshotAccess(undefined, undefined, undefined)).toBe(true);
  });

  test("returns the cached observation screenshot with age and fresh failure", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const cachedPath = await imageFile("cached.png");

    const result = await captureDeviceScreenshot(
      args,
      "fleet-controller",
      undefined,
      dependencies(timer, { success: false, error: "device capture failed" }, { cachedPath }),
    );

    expect(result.structuredContent).toMatchObject({
      source: "cached",
      captureSource: "observation-cache",
      ageMs: 2_000,
      freshFailure: {
        code: "SCREENSHOT_CAPTURE_FAILED",
        message: "device capture failed",
        retryable: true,
      },
    });
    expect(result.content[1]).toMatchObject({ type: "image", data: png.toString("base64") });
  });

  test("uses the cached screenshot after a bounded fresh capture times out", async () => {
    const timer = new FakeTimer();
    const cachedPath = await imageFile("timeout-cached.png");
    const neverCompletes = new Promise<ScreenshotResult>(() => {});
    const pending = captureDeviceScreenshot(
      { ...args, timeoutMs: 100 },
      "fleet-controller",
      undefined,
      dependencies(timer, neverCompletes, { cachedPath }),
    );
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    timer.advanceTime(100);

    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      source: "cached",
      freshFailure: { code: "SCREENSHOT_CAPTURE_FAILED", retryable: true },
    });
    expect(result.content[1]).toMatchObject({ type: "image" });
  });

  test("returns a typed failure when neither capture nor cache is available", async () => {
    const result = await captureDeviceScreenshot(
      args,
      undefined,
      undefined,
      dependencies(new FakeTimer(), { success: false, error: "camera unavailable" }),
    );
    expect(result.structuredContent).toEqual({
      error: { code: "SCREENSHOT_CAPTURE_FAILED", message: "camera unavailable", retryable: true },
    });
  });

  test("rejects a non-file handle without reading and closes it", async () => {
    const fake = fakeFiles({ isFile: false, size: png.length, bytes: png });
    const deps = dependencies(new FakeTimer(), { success: true, path: "directory" });
    deps.files = fake.files;

    const result = await captureDeviceScreenshot(args, undefined, undefined, deps);

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCREENSHOT_READ_FAILED",
        message: "Screenshot file is missing or exceeds the 16 MiB response limit.",
      },
    });
    expect(fake.reads).toBe(0);
    expect(fake.closes).toBe(1);
  });

  test("rejects an oversized handle before reading and closes it", async () => {
    const fake = fakeFiles({ size: maxScreenshotBytes + 1 });
    const deps = dependencies(new FakeTimer(), { success: true, path: "oversized" });
    deps.files = fake.files;

    const result = await captureDeviceScreenshot(args, undefined, undefined, deps);

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCREENSHOT_READ_FAILED",
        message: "Screenshot file is missing or exceeds the 16 MiB response limit.",
      },
    });
    expect(fake.reads).toBe(0);
    expect(fake.closes).toBe(1);
  });

  test("bounds reads when a file grows after handle stat", async () => {
    const fake = fakeFiles({ size: png.length, growing: true });
    const deps = dependencies(new FakeTimer(), { success: true, path: "growing" });
    deps.files = fake.files;

    const result = await captureDeviceScreenshot(args, undefined, undefined, deps);

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCREENSHOT_READ_FAILED",
        message: "Screenshot exceeds the 16 MiB response limit.",
      },
    });
    expect(fake.reads).toBeGreaterThan(0);
    expect(fake.closes).toBe(1);
  });

  test("rechecks authorization after a capture and withholds its image if ownership changes", async () => {
    const timer = new FakeTimer();
    const freshPath = await imageFile("ownership.png");
    let authorized = true;
    const result = await captureDeviceScreenshot(
      args,
      "fleet-controller",
      undefined,
      dependencies(
        timer,
        { success: true, path: freshPath },
        {
          authorized: () => authorized,
          onCapture: () => {
            authorized = false;
          },
        },
      ),
    );
    expect(result.structuredContent).toMatchObject({ error: { code: "SCREENSHOT_ACCESS_DENIED" } });
    expect(result.content).toHaveLength(1);
  });

  test("does not return cached pixels after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await captureDeviceScreenshot(
      args,
      "fleet-controller",
      controller.signal,
      dependencies(new FakeTimer(), { success: false }),
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: "SCREENSHOT_CAPTURE_CANCELLED" },
    });
    expect(result.content).toHaveLength(1);
  });
});
