import { describe, expect, test } from "bun:test";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { resolveBootCapacityLimits } from "../../../src/devices/bootAdmission/capacityLimits";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const MODE = "AUTOMOBILE_ANDROID_BOOT_BUDGET_VCPUS";

// 64 GiB and 16 cores: by memory floor(32 / 4) = 8, by cores floor(16 / 2) = 8 until vCPUs count.
function gate(
  env: NodeJS.ProcessEnv,
  candidate: { cpuCores?: number } | undefined,
  running: number,
) {
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 64 * GIB, cpuCount: 16 };
  source.emulatorSerials = Array.from(
    { length: running },
    (_, index) => `emulator-${5554 + 2 * index}`,
  );
  return new AndroidBootAdmissionGate(source, new FakeTimer(), {
    env,
    resolvedHardware: async () => candidate,
  });
}

const admitted = (target: AndroidBootAdmissionGate): Promise<boolean> =>
  target
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

describe("boot core budget (#15476)", () => {
  test("by default each emulator is budgeted two cores whatever its AVD resolved to", async () => {
    expect(await admitted(gate({}, { cpuCores: 4 }, 7))).toBe(true);
    expect(await admitted(gate({}, { cpuCores: 4 }, 8))).toBe(false);
  });

  test("configured mode budgets the AVD's own four vCPUs: limit 4", async () => {
    expect(await admitted(gate({ [MODE]: "configured" }, { cpuCores: 4 }, 3))).toBe(true);
    expect(await admitted(gate({ [MODE]: "configured" }, { cpuCores: 4 }, 4))).toBe(false);
  });

  test("configured mode with a two-vCPU AVD keeps today's limit of 8", async () => {
    expect(await admitted(gate({ [MODE]: "configured" }, { cpuCores: 2 }, 7))).toBe(true);
    expect(await admitted(gate({ [MODE]: "configured" }, { cpuCores: 2 }, 8))).toBe(false);
  });

  test("configured mode without a resolved vCPU count falls back to two cores", async () => {
    expect(await admitted(gate({ [MODE]: "configured" }, undefined, 7))).toBe(true);
    expect(await admitted(gate({ [MODE]: "configured" }, {}, 8))).toBe(false);
  });

  test("any other value keeps the fixed budget", async () => {
    expect(await admitted(gate({ [MODE]: "fixed" }, { cpuCores: 4 }, 7))).toBe(true);
  });
});

describe("resolveBootCapacityLimits cores per device", () => {
  const host = { totalMemoryBytes: 64 * GIB, cpuCount: 16 };
  test("defaults to two and honours an explicit count, never below one", () => {
    expect(resolveBootCapacityLimits({}, "X", host, 4 * GIB).maxBooted).toBe(8);
    expect(resolveBootCapacityLimits({}, "X", host, 4 * GIB, 4).maxBooted).toBe(4);
    expect(resolveBootCapacityLimits({}, "X", host, 1 * GIB, 0).maxBooted).toBe(16);
  });
});
