import { describe, expect, spyOn, test } from "bun:test";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import {
  ANDROID_EMULATOR_MEMORY_POLICY,
  raisePerDeviceBytes,
} from "../../../src/devices/bootAdmission/capacityLimits";
import { logger } from "../../../src/utils/logger";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// 32 GiB and 16 cores, no override: the derived limit is floor(16 GiB / perDevice), at most 8 by CPU.
function gateWith(resolvedGuestBytes: (avdName: string) => Promise<number | undefined>) {
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 32 * GIB, cpuCount: 16 };
  source.emulatorSerials = ["emulator-5554", "emulator-5556"];
  return new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {}, resolvedGuestBytes });
}

describe("boot capacity with the AVD's resolved RAM (#15475)", () => {
  test("a 4096 MB resolved AVD leaves the default 4 GiB estimate: 2 booted, limit 4, admitted", async () => {
    const admission = await gateWith(async () => 4096 * MIB).admit({
      timeoutMs: 1000,
      avdName: "a",
    });
    admission.release();
  });

  test("a 2048 MB resolved AVD never lowers the estimate below the default", async () => {
    const admission = await gateWith(async () => 2048 * MIB).admit({
      timeoutMs: 1000,
      avdName: "a",
    });
    admission.release();
  });

  test("an 8 GiB resolved AVD raises the per-emulator estimate and the same host refuses", async () => {
    const error = await gateWith(async () => 8 * GIB)
      .admit({ timeoutMs: 1000, avdName: "big" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("the resolver is asked for the AVD being booted", async () => {
    const asked: string[] = [];
    const admission = await gateWith(async (avdName) => {
      asked.push(avdName);
      return undefined;
    }).admit({ timeoutMs: 1000, avdName: "Pixel_9" });
    admission.release();
    expect(asked).toEqual(["Pixel_9"]);
  });

  test("a failing read warns and falls back to the existing estimate", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const admission = await gateWith(async () => {
        throw new Error("unreadable");
      }).admit({ timeoutMs: 1000, avdName: "a" });
      admission.release();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("raisePerDeviceBytes", () => {
  const policy = ANDROID_EMULATOR_MEMORY_POLICY;
  test("only raises, and respects the policy maximum", () => {
    expect(raisePerDeviceBytes(4 * GIB, undefined, policy)).toBe(4 * GIB);
    expect(raisePerDeviceBytes(4 * GIB, 2 * GIB, policy)).toBe(4 * GIB);
    expect(raisePerDeviceBytes(4 * GIB, 6 * GIB, policy)).toBe(6 * GIB);
    expect(raisePerDeviceBytes(4 * GIB, 64 * GIB, policy)).toBe(policy.maxBytes);
    expect(raisePerDeviceBytes(4 * GIB, Number.NaN, policy)).toBe(4 * GIB);
  });
});
