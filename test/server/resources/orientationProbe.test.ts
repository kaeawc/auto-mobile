import { describe, expect, test } from "bun:test";
import { probeDeviceOrientation } from "../../../src/server/bootedDeviceResources";
import type { OrientationReader } from "../../../src/features/action/OrientationReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const device = { name: "Pixel", platform: "android" as const, deviceId: "emulator-5554" };

describe("probeDeviceOrientation", () => {
  test("aborts a slow orientation reader when the remaining budget expires", async () => {
    const timer = new FakeTimer();
    let receivedSignal: AbortSignal | undefined;
    const reader: OrientationReader = {
      readOrientation: async (_device, signal) => {
        receivedSignal = signal;
        return await new Promise<never>(() => {});
      },
    };

    const result = probeDeviceOrientation(device, reader, timer.now() + 100, timer);
    timer.advanceTime(100);

    expect(await result).toBeNull();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("does not abort an orientation reader that completes within budget", async () => {
    const timer = new FakeTimer();
    let receivedSignal: AbortSignal | undefined;
    const reader: OrientationReader = {
      readOrientation: async (_device, signal) => {
        receivedSignal = signal;
        return "portrait";
      },
    };

    expect(await probeDeviceOrientation(device, reader, timer.now() + 100, timer)).toBe("portrait");
    expect(receivedSignal?.aborted).toBe(false);
  });
});
