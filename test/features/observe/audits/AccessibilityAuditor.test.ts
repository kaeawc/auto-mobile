import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  AccessibilityAuditor,
  resolveObservationScreenshotPath,
} from "../../../../src/features/observe/audits/AccessibilityAuditor";
import { InMemoryScreenshotStateStore } from "../../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
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

/** Minimal typed fields the auditor needs: an app, an (empty) hierarchy, an observation id. */
function auditableObservation(observationId: string): Partial<ObserveResult> {
  return {
    observationId,
    activeWindow: { appId: "com.example", activityName: "Main", layoutSeqSum: 0 },
    viewHierarchy: { hierarchy: { node: {} } },
  };
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

  test("asks the resolver for exactly this observation's screenshot", async () => {
    const requested: string[] = [];
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
      screenshotPathResolver: async (observationId) => {
        requested.push(observationId);
        return undefined;
      },
    });
    const result = makeResult(auditableObservation("obs-B"));
    await auditor.run(result, new NoOpPerformanceTracker());

    expect(requested).toEqual(["obs-B"]);
  });

  test("skips contrast and says so when the observation has no screenshot (#10037)", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
      screenshotPathResolver: async () => undefined,
    });
    const result = makeResult(auditableObservation("obs-B"));
    await auditor.run(result, new NoOpPerformanceTracker());

    expect(result.accessibilityAudit?.summary.byType["insufficient-contrast"]).toBe(0);
    expect(result.accessibilityAudit?.summary.notEvaluated).toEqual([
      { check: "insufficient-contrast", reason: "no screenshot for this observation" },
    ]);
  });

  test("never falls back to another capture when no resolver is wired", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult(auditableObservation("obs-B"));
    await auditor.run(result, new NoOpPerformanceTracker());

    expect(result.accessibilityAudit?.summary.notEvaluated).toHaveLength(1);
  });
});

describe("resolveObservationScreenshotPath", () => {
  const deviceId = "dev-1";
  let dir: string;
  let store: InMemoryScreenshotStateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "auditor-observation-shot-"));
    store = new InMemoryScreenshotStateStore(new FakeTimer());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedScreenshot(name: string): Promise<string> {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, Buffer.alloc(8));
    return filePath;
  }

  function resolveFor(observationId: string): Promise<string | undefined> {
    return resolveObservationScreenshotPath(store.getPathForObservation(deviceId, observationId));
  }

  test("returns the path recorded for the same observation", async () => {
    const shotA = await seedScreenshot("a.jpg");
    store.updateForObservation(deviceId, "obs-A", shotA);

    expect(await resolveFor("obs-A")).toBe(shotA);
  });

  test("does not hand observation B the device-wide capture of observation A", async () => {
    const shotA = await seedScreenshot("a.jpg");
    store.update(deviceId, shotA);
    store.updateForObservation(deviceId, "obs-A", shotA);

    expect(await resolveFor("obs-B")).toBeUndefined();
  });

  test("returns nothing when this observation's capture failed, even with older files on disk", async () => {
    await seedScreenshot("older-screen.jpg");
    store.updateForObservation(deviceId, "obs-B", undefined, "screencap failed");

    expect(await resolveFor("obs-B")).toBeUndefined();
  });

  test("returns nothing when this observation's capture was cancelled", async () => {
    const shotA = await seedScreenshot("a.jpg");
    store.update(deviceId, shotA);
    store.endObservation(deviceId, "obs-B", "capture cancelled");

    expect(await resolveFor("obs-B")).toBeUndefined();
  });

  test("returns nothing when the recorded file is gone", async () => {
    store.updateForObservation(deviceId, "obs-B", path.join(dir, "missing.jpg"));

    expect(await resolveFor("obs-B")).toBeUndefined();
  });
});
