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
    expect(fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("getBootedDevices"))).toBe(
      true,
    );
  });

  test("keeps the resource pointers as a note", async () => {
    const payload = await callListDevices();

    expect(payload.note).toBeDefined();
    const noteText = JSON.stringify(payload.note);
    expect(noteText).toContain("automobile:devices/booted");
    expect(noteText).toContain("automobile:devices/images");
  });

  test("filters by platform when provided", async () => {
    const payload = await callListDevices({ platform: "android" });

    expect(payload.count).toBe(1);
    expect(payload.devices).toEqual([
      expect.objectContaining({ platform: "android", deviceId: "emulator-5554" }),
    ]);
  });
});
