import { expect, test } from "bun:test";
import {
  resolveVideoStreamDevice,
  validateCaptureHints,
} from "../../src/daemon/videoStreamSocketServer";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

const android: BootedDevice = { deviceId: "android", name: "Android", platform: "android" };
const ios: BootedDevice = { deviceId: "ios", name: "iOS", platform: "ios" };

for (const platform of [undefined, "android", "ios"] as const) {
  test(`video subscribe accepts ${platform ?? "an absent"} platform`, () => {
    expect(validateCaptureHints({ action: "subscribe", platform })).toBeNull();
  });
}

for (const platform of ["", null, "windows", 5] as const) {
  test(`video subscribe rejects malformed platform ${JSON.stringify(platform)}`, () => {
    expect(validateCaptureHints({ action: "subscribe", platform })).toContain("Invalid platform");
  });
}

for (const platform of ["android", "ios"] as const) {
  test(`video discovery scopes to ${platform}`, async () => {
    const platforms: string[] = [];
    const device = await resolveVideoStreamDevice(
      {
        getBootedDevices: async (requested) => {
          platforms.push(requested);
          return requested === "either" ? [android, ios] : requested === "ios" ? [ios] : [android];
        },
      },
      undefined,
      platform,
    );
    expect(platforms).toEqual([platform]);
    expect(device.platform).toBe(platform);
  });
}

test("video iOS discovery uses the injected retry timer", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let calls = 0;
  const device = await resolveVideoStreamDevice(
    {
      getBootedDevices: async () => (++calls === 1 ? [] : [ios]),
    },
    undefined,
    "ios",
    timer,
  );
  expect(device).toBe(ios);
  expect(calls).toBe(2);
});

test("video iOS discovery aborts its retry", async () => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  const pending = resolveVideoStreamDevice(
    { getBootedDevices: async () => [] },
    undefined,
    "ios",
    timer,
    controller.signal,
  );
  // Allow the resolver to enter its fake-timer retry without wall-clock sleeps.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
});

test("omitted platform retains mixed-platform ambiguity", async () => {
  await expect(
    resolveVideoStreamDevice({ getBootedDevices: async () => [android, ios] }),
  ).rejects.toThrow("Multiple connected devices");
});
