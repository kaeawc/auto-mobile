import { describe, expect, test } from "bun:test";
import {
  AllDisplaysObservation,
  type AllDisplaysObservationDependencies,
} from "../../../src/features/observe/AllDisplaysObservation";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ScreenshotPathProtection } from "../../../src/features/observe/ScreenshotPathProtection";

const androidDevice: BootedDevice = {
  deviceId: "all-displays-android",
  name: "Fold",
  platform: "android",
  displays: {
    panels: [
      { key: "inner-id", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover-id", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: [],
  },
};

function baseResult(): ObserveResult {
  return {
    observationId: "obs",
    deviceId: androidDevice.deviceId,
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    insets: { available: false, source: "unavailable", units: "unknown" },
  };
}

const protection: ScreenshotPathProtection = {
  removeIfUnprotected: async () => {
    throw new Error("Unexpected removal");
  },
  isProtected: () => false,
  start: () => {},
  sweep: async () => {},
  sweepOnce: async () => {},
  write: async () => {
    throw new Error("Unexpected write");
  },
  protect: async () => 1,
};

function build(overrides: Partial<AllDisplaysObservationDependencies> = {}) {
  const calls: Array<{ display?: string; skipScreenshot?: boolean }> = [];
  const timer = new FakeTimer();
  const deps: AllDisplaysObservationDependencies = {
    device: () => androidDevice,
    timer: () => timer,
    pathProtection: () => protection,
    executeSingleDisplay: async (options) => {
      calls.push({ display: options.display, skipScreenshot: options.skipScreenshot });
      const key = options.display === "active" ? "inner-id" : (options.display ?? "0");
      return { ...baseResult(), display: { ...baseResult().display, key } };
    },
    captureDeviceReadScreenshot: async () => {},
    createCriticalFallback: () => baseResult(),
    createBaseResult: baseResult,
    ...overrides,
  };
  return { observation: new AllDisplaysObservation(deps), calls };
}

describe("AllDisplaysObservation", () => {
  test("reads the active panel once and the remaining panels without screenshots", async () => {
    const { observation, calls } = build();
    const result = await observation.execute();
    expect(calls).toEqual([
      { display: "active", skipScreenshot: undefined },
      { display: "cover-id", skipScreenshot: true },
    ]);
    expect(result.displays?.map((d) => [d.display.key, d.display.role])).toEqual([
      ["inner-id", "inner"],
      ["cover-id", "cover"],
    ]);
  });

  test("returns the plain active result when the device has no panel inventory", async () => {
    const { observation, calls } = build({
      device: () => ({ ...androidDevice, displays: undefined }),
    });
    const result = await observation.execute();
    expect(calls).toHaveLength(1);
    expect(result.displays).toBeUndefined();
  });

  test("marks a failed non-active panel unavailable instead of failing the aggregate", async () => {
    const { observation } = build({
      executeSingleDisplay: async (options) => {
        if (options.display === "cover-id") {
          throw new Error("panel gone");
        }
        return { ...baseResult(), display: { ...baseResult().display, key: "inner-id" } };
      },
    });
    const result = await observation.execute();
    const cover = result.displays?.find((d) => d.display.key === "cover-id");
    expect(cover?.freshness?.category).toBe("unavailable");
    expect(cover?.freshness?.unavailableDetail).toContain("panel gone");
  });

  test("a failed active read falls back to the critical result", async () => {
    const fallback = { ...baseResult(), observationId: "critical" };
    const { observation } = build({
      executeSingleDisplay: async () => {
        throw new Error("boom");
      },
      createCriticalFallback: () => fallback,
    });
    const result = await observation.execute();
    expect(result.observationId).toBe("critical");
  });

  test("rejects iOS", async () => {
    const { observation } = build({ device: () => ({ ...androidDevice, platform: "ios" }) });
    await expect(observation.execute()).rejects.toThrow("unsupported on iOS");
  });
});
