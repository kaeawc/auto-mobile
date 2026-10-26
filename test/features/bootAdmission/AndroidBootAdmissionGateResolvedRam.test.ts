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
function gateWith(
  resolvedGuestBytes: (avdName: string) => Promise<number | undefined>,
  running: number,
) {
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 32 * GIB, cpuCount: 16 };
  source.emulatorSerials = Array.from(
    { length: running },
    (_, index) => `emulator-${5554 + 2 * index}`,
  );
  return new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {}, resolvedGuestBytes });
}

const admitted = async (gate: AndroidBootAdmissionGate): Promise<boolean> =>
  gate
    .admit({ timeoutMs: 1000, avdName: "a" })
    .then((admission) => {
      admission.release();
      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof BootCapacityExhaustedError) {
        return false;
      }
      throw error;
    });

describe("boot capacity with the AVD's resolved RAM (#15475)", () => {
  test("a 4096 MB resolved AVD keeps the 4 GiB default: limit 4, so 3 running admits and 4 refuses", async () => {
    expect(await admitted(gateWith(async () => 4096 * MIB, 3))).toBe(true);
    expect(await admitted(gateWith(async () => 4096 * MIB, 4))).toBe(false);
  });

  test("a 2048 MB resolved AVD never lowers the estimate: 4 running still refuses", async () => {
    expect(await admitted(gateWith(async () => 2048 * MIB, 4))).toBe(false);
    expect(await admitted(gateWith(async () => undefined, 4))).toBe(false);
  });

  test("a 6 GiB resolved AVD raises the estimate to limit 2: 1 running admits, 2 refuse", async () => {
    expect(await admitted(gateWith(async () => 6 * GIB, 1))).toBe(true);
    expect(await admitted(gateWith(async () => 6 * GIB, 2))).toBe(false);
    expect(await admitted(gateWith(async () => undefined, 2))).toBe(true);
  });

  test("the resolver is asked for the AVD being booted", async () => {
    const asked: string[] = [];
    const admission = await gateWith(async (avdName) => {
      asked.push(avdName);
      return undefined;
    }, 1).admit({ timeoutMs: 1000, avdName: "Pixel_9" });
    admission.release();
    expect(asked).toEqual(["Pixel_9"]);
  });

  test("a failing read warns and falls back to the existing estimate", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        await admitted(
          gateWith(async () => {
            throw new Error("unreadable");
          }, 1),
        ),
      ).toBe(true);
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
