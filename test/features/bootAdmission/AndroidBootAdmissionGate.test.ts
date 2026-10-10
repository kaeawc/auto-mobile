import { describe, expect, test } from "bun:test";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const AVD = "Pixel_9";

function setup(env: NodeJS.ProcessEnv = { [ANDROID_MAX_BOOTED_ENV]: "2" }) {
  const timer = new FakeTimer();
  const source = new FakeAndroidCapacitySource();
  const gate = new AndroidBootAdmissionGate(source, timer, { env });
  return { timer, source, gate };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("AndroidBootAdmissionGate (#11181)", () => {
  test("admits a boot below the limit without waiting", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = ["emulator-5554"];

    const admission = await gate.admit({ timeoutMs: 60_000, avdName: AVD });

    expect(source.samples).toBe(1);
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 1, inFlight: 1 });
    admission.release();
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 1, inFlight: 0 });
  });

  test("refuses at capacity at once, without sampling again or sleeping", async () => {
    const { timer, source, gate } = setup();
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];

    const error = await rejection(gate.admit({ timeoutMs: 120_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(source.samples).toBe(1);
    expect(timer.now()).toBe(0);
    expect(timer.getPendingSleepCount()).toBe(0);
  });

  test("admits right away once an emulator has shut down", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];
    await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));
    source.emulatorSerials = ["emulator-5554"];

    await gate.admit({ timeoutMs: 60_000, avdName: AVD });
  });

  test("fails with the typed retryable capacity_exhausted error immediately", async () => {
    const { timer, source, gate } = setup();
    timer.enableAutoAdvance();
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];

    const error = await rejection(gate.admit({ timeoutMs: 12_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(error).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      details: {
        code: "capacity_exhausted",
        retryable: true,
        retryAfterMs: 5_000,
        limit: 2,
        booted: 2,
        platform: "android",
      },
    });
    expect(timer.now()).toBe(0);
  });

  test("counts emulators adb does not list: booting ones and ones on another adb server", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = ["emulator-5554"];
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB];

    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 2, inFlight: 0 });
    const error = await rejection(gate.admit({ timeoutMs: 1_000, avdName: AVD }));
    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("an admitted boot holds its slot until adb lists its serial", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = ["emulator-5554"];
    const admission = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    admission.handOff("emulator-5556");

    // Not listed yet: the concurrent request queues instead of overshooting the limit.
    const queued = await rejection(gate.admit({ timeoutMs: 1_000, avdName: AVD }));
    expect(queued).toBeInstanceOf(BootCapacityExhaustedError);

    // Listed: the adb count takes over and the hand-off leaves the ledger.
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 2, inFlight: 0 });
    source.emulatorSerials = ["emulator-5554"];
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 1, inFlight: 0 });
  });

  test("a booting emulator's qemu process is not counted twice with its admission", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = [];
    source.emulatorProcessRssBytes = [];
    const admission = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    admission.handOff("emulator-5554");
    source.emulatorProcessRssBytes = [3 * GIB];

    // One process plus its own admission is one emulator, so a second boot fits.
    const second = await gate.admit({ timeoutMs: 1_000, avdName: AVD });
    second.release();
  });

  test("a hand-off that never shows up in adb expires at the boot deadline", async () => {
    const { timer, source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    const admission = await gate.admit({ timeoutMs: 30_000, avdName: AVD });
    admission.handOff("emulator-5554");
    expect((await gate.describeCapacity()).inFlight).toBe(1);

    timer.advanceTime(30_000);

    expect((await gate.describeCapacity()).inFlight).toBe(0);
    expect(source.samples).toBe(3);
  });

  test("releasing on failure frees the slot for the next boot", async () => {
    const { gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.release();
    first.release();

    const second = await gate.admit({ timeoutMs: 1_000, avdName: AVD });
    expect((await gate.describeCapacity()).inFlight).toBe(1);
    second.release();
  });

  test("an abort before sampling rejects with the abort and admits nothing", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    const controller = new AbortController();
    controller.abort(new Error("boot cancelled"));

    const error = await rejection(
      gate.admit({ timeoutMs: 60_000, signal: controller.signal, avdName: AVD }),
    );

    expect(error).not.toBeInstanceOf(BootCapacityExhaustedError);
    expect(source.samples).toBe(0);
    expect((await gate.describeCapacity()).inFlight).toBe(0);
  });

  test("derives the limit from host RAM over measured emulator RSS, capped by cores", async () => {
    const { source, gate } = setup({});
    source.host = { totalMemoryBytes: 32 * GIB, cpuCount: 16 };
    source.emulatorProcessRssBytes = [4 * GIB, 4 * GIB];
    // 32 GiB x 0.5 / 4 GiB = 4; 16 cores / 2 = 8.
    expect((await gate.describeCapacity()).limit).toBe(4);

    source.host = { totalMemoryBytes: 64 * GIB, cpuCount: 4 };
    expect((await gate.describeCapacity()).limit).toBe(2);
  });

  test("uses a conservative per-emulator default when RSS is unavailable, never below 1", async () => {
    const { source, gate } = setup({});
    source.host = { totalMemoryBytes: 32 * GIB, cpuCount: 16 };
    source.emulatorProcessRssBytes = undefined;
    // 32 GiB x 0.5 / 4 GiB default.
    expect((await gate.describeCapacity()).limit).toBe(4);

    source.host = { totalMemoryBytes: 2 * GIB, cpuCount: 1 };
    expect((await gate.describeCapacity()).limit).toBe(1);
  });

  test("an invalid override falls back to the derived limit", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "lots" });
    source.host = { totalMemoryBytes: 32 * GIB, cpuCount: 16 };
    expect((await gate.describeCapacity()).limit).toBe(4);
  });
});

describe("capacity_exhausted names external devices (#11209)", () => {
  test("lists counted emulators AutoMobile did not start and the override and opt-out env vars", async () => {
    const { timer, source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "2" });
    timer.enableAutoAdvance();
    source.emulatorSerials = ["emulator-5554"];
    const owned = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    owned.handOff("emulator-5556");
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];

    const error = await rejection(gate.admit({ timeoutMs: 6_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    const exhausted = error as BootCapacityExhaustedError;
    expect(exhausted.details.externalDevices).toEqual(["emulator-5554"]);
    expect(exhausted.message).toContain("emulator-5554");
    expect(exhausted.message).not.toContain("emulator-5556,");
    expect(exhausted.message).toContain("AUTOMOBILE_ANDROID_MAX_BOOTED");
    expect(exhausted.message).toContain("AUTOMOBILE_BOOT_CAPACITY_GATE=0");
  });

  test("omits the external note when every counted emulator was started here", async () => {
    const { timer, source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    timer.enableAutoAdvance();
    const owned = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    owned.handOff("emulator-5554");
    source.emulatorSerials = ["emulator-5554"];

    const error = (await rejection(
      gate.admit({ timeoutMs: 6_000, avdName: AVD }),
    )) as BootCapacityExhaustedError;

    expect(error.details.externalDevices).toBeUndefined();
    expect(error.message).not.toContain("not started by AutoMobile");
  });
});
