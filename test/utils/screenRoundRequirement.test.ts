import { describe, expect, it } from "bun:test";
import type { BootedDevice, DeviceInfo } from "../../src/models/DeviceInfo";
import type { DeviceMatchCriteria } from "../../src/models/DeviceMatchCriteria";
import { wearProfileScreenRound } from "../../src/models/formFactor";
import {
  assertCreatableRequirements,
  DefaultDeviceMatcher,
  matchesDeviceCriteria,
} from "../../src/utils/deviceMatcher";
import { nextToPick, type Random } from "../../src/utils/Random";

class FirstRandom implements Random {
  next(): number {
    return 0;
  }
  pick<T>(items: readonly T[]): T {
    return nextToPick(() => this.next(), items);
  }
}

const RUNTIME = "system-images;android-37.0;android-wear-signed;arm64-v8a";
const watch = (shape: "round" | "square"): DeviceMatchCriteria => ({
  platform: "android",
  formFactor: "watch",
  requires: { screenRound: shape === "round" },
});

const stoppedWatch = (deviceType?: string): DeviceInfo => ({
  name: "wear-37",
  platform: "android",
  isRunning: false,
  formFactor: "watch",
  runtimeId: RUNTIME,
  ...(deviceType ? { deviceType } : {}),
});

const bootedWatch = (deviceType?: string): BootedDevice => ({
  name: "wear-37",
  platform: "android",
  deviceId: "emulator-5554",
  formFactor: "watch",
  runtimeId: RUNTIME,
  ...(deviceType ? { deviceType } : {}),
});

describe("requires.screenRound matches only a watch of that shape", () => {
  const matcher = new DefaultDeviceMatcher(new FirstRandom());

  it("does not reuse a stopped round watch for a square request", () => {
    const images = [stoppedWatch("wearos_small_round")];
    expect(matcher.matchDeviceImage(watch("square"), images, "LATEST")).toBeNull();
    expect(matcher.matchDeviceImage(watch("round"), images, "LATEST")?.deviceType).toBe(
      "wearos_small_round",
    );
  });

  it("does not reuse a booted round watch for a square request", () => {
    const devices = [bootedWatch("wearos_large_round")];
    expect(matcher.matchBootedDevice(watch("square"), devices, "LATEST")).toBeNull();
    expect(matcher.matchBootedDevice(watch("round"), devices, "LATEST")?.deviceId).toBe(
      "emulator-5554",
    );
  });

  it("picks the square watch when round and square both exist", () => {
    const devices = [bootedWatch("wearos_small_round"), bootedWatch("wearos_square")];
    expect(matcher.matchBootedDevice(watch("square"), devices, "LATEST")?.deviceType).toBe(
      "wearos_square",
    );
  });

  it("rejects a watch whose profile shape is unknown and keeps it when no shape is asked", () => {
    expect(matchesDeviceCriteria(stoppedWatch(), watch("round"))).toBe(false);
    expect(matchesDeviceCriteria(bootedWatch(), watch("square"))).toBe(false);
    expect(
      matchesDeviceCriteria(stoppedWatch("wearos_small_round"), {
        platform: "android",
        formFactor: "watch",
      }),
    ).toBe(true);
  });

  it.each([
    ["wearos_small_round", true],
    ["wear_round_chin_320_290", true],
    ["wearos_square", false],
    ["wearos_rect", false],
    ["wearos_large", undefined],
    ["pixel_round", undefined],
    [undefined, undefined],
  ] as const)("wearProfileScreenRound(%p) is %p", (profileId, expected) => {
    expect(wearProfileScreenRound(profileId)).toBe(expected);
  });
});

describe("requires.screenRound outside a Wear OS Android request", () => {
  it.each([
    { platform: "ios" as const, formFactor: "watch" as const },
    { platform: "android" as const, formFactor: "phone" as const },
    { platform: "android" as const },
  ])("refuses to create for %j", (base) => {
    expect(() =>
      assertCreatableRequirements({ ...base, requires: { screenRound: false } }, []),
    ).toThrow(/requires\.screenRound applies to Wear OS emulators only/);
  });

  it("lets a Wear OS Android request be created", () => {
    expect(() => assertCreatableRequirements(watch("square"), [])).not.toThrow();
  });
});
