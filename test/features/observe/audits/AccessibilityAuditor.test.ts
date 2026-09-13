import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  AccessibilityAuditor,
  findLatestScreenshotPath,
} from "../../../../src/features/observe/audits/AccessibilityAuditor";
import { TEMP_SUBDIRS } from "../../../../src/utils/tempDir";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import type { AccessibilityAuditConfig } from "../../../../src/models/AccessibilityAudit";

function makeResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  } as ObserveResult;
}

const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };
const iosDevice: BootedDevice = { deviceId: "ios-1", name: "ios", platform: "ios" };

const enabledConfig: AccessibilityAuditConfig = {
  level: "AA",
} as AccessibilityAuditConfig;

describe("AccessibilityAuditor", () => {
  test("does nothing when getConfig returns null", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => null,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when device platform is not android", async () => {
    const auditor = new AccessibilityAuditor({
      device: iosDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no view hierarchy", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no activeWindow.appId", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("audit failures do not pollute result.errors", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
      // Force the resolver to throw — exercises catch path.
      screenshotPathResolver: async () => {
        throw new Error("boom");
      },
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.errors).toBeUndefined();
  });
});

describe("findLatestScreenshotPath", () => {
  let dataDir: string;
  let screenshotDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "auditor-screenshots-"));
    screenshotDir = path.join(dataDir, TEMP_SUBDIRS.SCREENSHOTS);
    await fs.mkdir(screenshotDir, { recursive: true });
    previousDataDir = process.env.AUTOMOBILE_DATA_DIR;
    process.env.AUTOMOBILE_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) {
      delete process.env.AUTOMOBILE_DATA_DIR;
    } else {
      process.env.AUTOMOBILE_DATA_DIR = previousDataDir;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function seed(name: string, mtimeSeconds: number): Promise<string> {
    const filePath = path.join(screenshotDir, name);
    await fs.writeFile(filePath, Buffer.alloc(8));
    await fs.utimes(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
  }

  test("finds a .jpg capture when the cache holds only CtrlProxy output", async () => {
    const jpg = await seed("screenshot_2.jpg", 2_000);

    expect(await findLatestScreenshotPath()).toBe(jpg);
  });

  test("picks the newest file by mtime across mixed .jpg/.png/.webp content", async () => {
    await seed("screenshot_1.png", 1_000);
    await seed("screenshot_2.webp", 2_000);
    const newest = await seed("screenshot_3.jpg", 3_000);

    expect(await findLatestScreenshotPath()).toBe(newest);
  });

  test("ignores another device's newer capture when resolving for a known device", async () => {
    await seed("screenshot_1_device-a_aaa.jpg", 1_000);
    const ownCapture = await seed("screenshot_2_device-b_bbb.jpg", 2_000);
    await seed("screenshot_3_device-a_ccc.jpg", 3_000);

    expect(await findLatestScreenshotPath("device-b")).toBe(ownCapture);
  });

  test("returns nothing when the requested device has no capture on disk", async () => {
    await seed("screenshot_3_device-a_ccc.jpg", 3_000);

    expect(await findLatestScreenshotPath("device-b")).toBeUndefined();
  });

  test("matches captures whose device id needed sanitizing for the filename", async () => {
    const own = await seed("screenshot_4_127-0-0-1-5555_ddd.png", 4_000);

    expect(await findLatestScreenshotPath("127.0.0.1:5555")).toBe(own);
  });
});
