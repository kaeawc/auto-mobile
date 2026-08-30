import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const resolveWithFakeTimer = async <T>(
  promise: Promise<T>,
  timer: FakeTimer,
  stepMs: number = 10,
): Promise<T> => {
  let settled = false;
  let result: T | undefined;
  let error: unknown;

  promise
    .then((value) => {
      settled = true;
      result = value;
    })
    .catch((caught) => {
      settled = true;
      error = caught;
    });

  let steps = 0;
  while (!settled) {
    if (
      timer.getPendingTimeoutCount() > 0 ||
      timer.getPendingIntervalCount() > 0 ||
      timer.getPendingSleepCount() > 0
    ) {
      timer.advanceTime(stepMs);
    }
    await new Promise((resolve) => setImmediate(resolve));
    steps += 1;
    if (steps > 200) {
      throw new Error("FakeTimer pump exceeded max steps");
    }
  }

  if (error) {
    throw error;
  }

  return result as T;
};

describe("listDevices tool (#5870)", () => {
  let fakeDeviceUtils: FakeDeviceUtils;

  const android: BootedDevice = {
    platform: "android",
    name: "Pixel_9_API_36",
    deviceId: "emulator-5554",
  };
  const ios: BootedDevice = {
    platform: "ios",
    name: "iPhone 17",
    deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
    iosVersion: "18.0",
  };

  const callListDevices = async (args: Record<string, unknown> = {}) => {
    const tool = ToolRegistry.getTool("listDevices");
    expect(tool).toBeDefined();
    const fakeTimer = new FakeTimer();
    const response = await resolveWithFakeTimer(tool!.handler(args), fakeTimer);
    expect(response.content?.[0]?.type).toBe("text");
    return JSON.parse(response.content?.[0]?.text ?? "{}");
  };

  beforeAll(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
    });

    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }
  });

  beforeEach(() => {
    fakeDeviceUtils.clearHistory();
    fakeDeviceUtils.failedPlatforms.clear();
    fakeDeviceUtils.failedSources.clear();
    fakeDeviceUtils.omitSucceededSources = false;
    fakeDeviceUtils.setBootedDevices("android", [android]);
    fakeDeviceUtils.setBootedDevices("ios", [ios]);
  });

  afterAll(() => {
    resetDeviceToolsDependencies();
  });

  test("returns the actual booted devices instead of prose", async () => {
    const payload = await callListDevices();

    expect(payload.count).toBe(2);
    expect(Array.isArray(payload.devices)).toBe(true);
    expect(payload.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "android",
          deviceId: "emulator-5554",
          name: "Pixel_9_API_36",
        }),
        expect.objectContaining({
          platform: "ios",
          deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
          name: "iPhone 17",
        }),
      ]),
    );

    // The device manager is actually consulted now.
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("getBootedDevices")),
    ).toBe(true);
  });

  test("keeps the resource pointers as a note", async () => {
    const payload = await callListDevices();

    expect(payload.note).toBeDefined();
    const noteText = JSON.stringify(payload.note);
    expect(noteText).toContain("automobile:devices/booted");
    expect(noteText).toContain("automobile:devices/images");
  });

  test("marks discovery complete when every requested platform succeeds", async () => {
    const payload = await callListDevices();

    // #5893 item 4: a full sweep is explicitly complete, so an empty inventory
    // is distinguishable from a failed scan.
    expect(payload.discovery).toBeDefined();
    expect(payload.discovery.complete).toBe(true);
    expect(payload.discovery.failedPlatforms ?? []).toEqual([]);
  });

  test("surfaces an incomplete marker when a platform's discovery fails (#5893)", async () => {
    // iOS discovery is unavailable this sweep; Android still succeeds.
    fakeDeviceUtils.failedPlatforms.add("ios");

    const payload = await callListDevices();

    // Only the reachable platform's device is returned...
    expect(payload.count).toBe(1);
    expect(payload.devices).toEqual([
      expect.objectContaining({ platform: "android", deviceId: "emulator-5554" }),
    ]);

    // ...but the response makes the failed scan distinguishable from empty.
    expect(payload.discovery).toBeDefined();
    expect(payload.discovery.complete).toBe(false);
    expect(payload.discovery.failedPlatforms).toEqual(["ios"]);
    expect(JSON.stringify(payload.discovery.errors)).toContain("iOS");
    // The detailed contract is what gets consulted now.
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("getBootedDevices")),
    ).toBe(true);
  });

  test("marks discovery incomplete when only physical-iOS (devicectl) discovery fails (#5918)", async () => {
    // macOS mixed outcome: simctl completed but devicectl did not. The iOS
    // platform still aggregates as succeeded (it tracks the simulator source),
    // so a platform-level marker would wrongly report `complete: true`.
    fakeDeviceUtils.failedSources.add("ios-physical");

    const payload = await callListDevices();

    // Source-level completeness catches the incomplete physical source...
    expect(payload.discovery.complete).toBe(false);
    // ...and surfaces exactly which source failed, not the whole platform.
    expect(payload.discovery.failedSources).toEqual(["ios-physical"]);
    // The simulator source completed, so the platform aggregate is unaffected.
    expect(payload.discovery.failedPlatforms).toEqual([]);
  });

  test("returns physical devices when only simulator (simctl) discovery fails (#5918)", async () => {
    // Reciprocal mixed outcome: simctl is down but devicectl still reports a
    // connected iPhone. The physical device must survive even though the iOS
    // platform aggregate (which tracks the simulator source) reports failed.
    const iphone: BootedDevice = {
      platform: "ios",
      name: "Jason's iPhone",
      deviceId: "00008120-001A2D3E4F5B6A2E",
      iosVersion: "18.0",
    };
    fakeDeviceUtils.setBootedDevices("ios", [ios, iphone]);
    fakeDeviceUtils.failedSources.add("ios-simulator");

    const payload = await callListDevices();

    // The physical device is still returned; the simulator's is not.
    expect(payload.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "android", deviceId: "emulator-5554" }),
        expect.objectContaining({ platform: "ios", deviceId: "00008120-001A2D3E4F5B6A2E" }),
      ]),
    );
    expect(payload.devices.some((d: { deviceId: string }) => d.deviceId === ios.deviceId)).toBe(
      false,
    );

    // Completeness reflects the incomplete simulator source.
    expect(payload.discovery.complete).toBe(false);
    expect(payload.discovery.failedSources).toEqual(["ios-simulator"]);
    // The platform aggregate tracks the simulator source, so it reports failed.
    expect(payload.discovery.failedPlatforms).toEqual(["ios"]);
  });

  test("reports every source when a whole iOS platform fails (#5918)", async () => {
    fakeDeviceUtils.failedPlatforms.add("ios");

    const payload = await callListDevices();

    expect(payload.discovery.complete).toBe(false);
    expect(payload.discovery.failedPlatforms).toEqual(["ios"]);
    expect(payload.discovery.failedSources).toEqual(
      expect.arrayContaining(["ios-simulator", "ios-physical"]),
    );
    expect(payload.discovery.failedSources).toHaveLength(2);
  });

  test("omits failedSources and falls back to platforms for pre-#5683 producers (#5918)", async () => {
    // A producer that predates per-source reporting returns no `succeededSources`.
    fakeDeviceUtils.omitSucceededSources = true;
    fakeDeviceUtils.failedPlatforms.add("ios");

    const payload = await callListDevices();

    // Completeness still resolves through the platform aggregate.
    expect(payload.discovery.complete).toBe(false);
    expect(payload.discovery.failedPlatforms).toEqual(["ios"]);
    // No source detail is fabricated when the producer did not report it.
    expect(payload.discovery.failedSources).toBeUndefined();
  });

  test("distinguishes a genuinely empty inventory from a failed scan", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setBootedDevices("ios", []);

    const payload = await callListDevices();

    expect(payload.count).toBe(0);
    expect(payload.discovery.complete).toBe(true);
    expect(payload.discovery.failedPlatforms ?? []).toEqual([]);
  });

  test("filters by platform when provided", async () => {
    const payload = await callListDevices({ platform: "android" });

    expect(payload.count).toBe(1);
    expect(payload.devices).toEqual([
      expect.objectContaining({ platform: "android", deviceId: "emulator-5554" }),
    ]);
  });
});
