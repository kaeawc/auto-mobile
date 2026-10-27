import { describe, expect, test } from "bun:test";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../src/features/bootAdmission/BootAdmissionGate";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const AVD = "Pixel_9";

function setup(env: NodeJS.ProcessEnv = { [ANDROID_MAX_BOOTED_ENV]: "2" }) {
  const timer = new FakeTimer();
  const source = new FakeAndroidCapacitySource();
  const gate = new AndroidBootAdmissionGate(source, timer, { env });
  return { timer, source, gate };
}

test("replacement credit affects admission comparison but preserves raw refusal diagnostics", async () => {
  const { gate, source } = setup();
  source.emulatorSerials = ["emulator-5554", "emulator-5556", "emulator-5558"];
  const error = await rejection(
    gate.reserveBoot({ replacingDeviceId: "emulator-5554", timeoutMs: 60_000 }),
  );
  expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  if (error instanceof BootCapacityExhaustedError) {
    expect(error.booted).toBe(3);
    expect(error.message).toContain("3 emulator(s) booted; limit is 2");
    expect(error.details).toMatchObject({
      booted: 3,
      code: "capacity_exhausted",
      retryable: true,
      retryAfterMs: 5_000,
    });
  }
});

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

  // #11236: a read-only check lets a caller refuse before creating an AVD it would delete.
  test("assertCapacityAvailable refuses at capacity and admits nothing below it", async () => {
    const { source, gate } = setup();
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];

    const error = await rejection(gate.assertCapacityAvailable());

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(error).toMatchObject({ details: { limit: 2, booted: 2, platform: "android" } });
    source.emulatorSerials = ["emulator-5554"];
    await gate.assertCapacityAvailable();
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 1, inFlight: 0 });
  });

  // #11236: with adb failed and no process table (Windows has no `ps`), zero emulators is a
  // guess; the gate used to read it as zero load and admit past the limit.
  test("refuses with retryable discovery_incomplete when the emulator count is unknown", async () => {
    const { source, gate } = setup();
    source.serialListingError = "adb server not running";
    source.emulatorProcessRssBytes = undefined;

    for (const check of [
      () => gate.admit({ timeoutMs: 60_000, avdName: AVD }),
      () => gate.assertCapacityAvailable(),
    ]) {
      const error = await rejection(check());
      expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
      expect(error).toMatchObject({ code: "discovery_incomplete", retryable: true });
      expect(String(error)).toContain("adb server not running");
    }
    expect(await rejection(gate.describeCapacity())).toBeInstanceOf(
      AndroidBootedDeviceDiscoveryIncompleteError,
    );
  });

  test("still counts by process table when only the adb listing failed", async () => {
    const { source, gate } = setup();
    source.serialListingError = "adb timed out";
    source.emulatorProcessRssBytes = [2 * GIB, 2 * GIB];

    expect(await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }))).toBeInstanceOf(
      BootCapacityExhaustedError,
    );
    source.emulatorProcessRssBytes = [2 * GIB];
    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
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
    admission.handOff("emulator-5554", 501);
    source.emulatorProcessRssBytes = [3 * GIB];
    source.emulatorProcessPids = [501];

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

  // #11465: an adb listing taken before the emulator showed up, still running when the boot ends.
  test("a sample started before a boot finished does not admit past the limit", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554");
    source.onSample = () => first.release();

    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    source.onSample = undefined;
    expect((await gate.describeCapacity()).inFlight).toBe(0);
  });

  // #11537: a newer listing shows the handed-off emulator and drops its ledger entry while an
  // older listing, taken before adb listed it, is still open for another admission.
  test("a handed-off boot another listing saw still holds its slot for an older open sample", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    const readNow = source.sample.bind(source);
    const beforeListed = await readNow();
    let finishOlderListing: () => void = () => {};
    source.sample = () =>
      new Promise((resolve) => {
        finishOlderListing = () => resolve(beforeListed);
      });
    const second = rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));
    source.sample = readNow;

    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554");
    source.emulatorSerials = ["emulator-5554"];
    expect(await gate.describeCapacity()).toEqual({ limit: 1, booted: 1, inFlight: 0 });
    finishOlderListing();

    expect(await second).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("a sample timeout is reported as retryable discovery_incomplete", async () => {
    const { timer, source, gate } = setup();
    source.sample = () => new Promise(() => {});

    const admission = rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));
    await Promise.resolve();
    timer.advanceTime(15_000);

    const error = await admission;
    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect(error).toMatchObject({ code: "discovery_incomplete", retryable: true });
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

  test("forgets a started serial once its emulator exits, so a later emulator on it is external (#11254)", async () => {
    const { timer, source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    timer.enableAutoAdvance();
    const owned = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    owned.handOff("emulator-5554");
    source.emulatorSerials = ["emulator-5554"];
    await rejection(gate.admit({ timeoutMs: 6_000, avdName: AVD }));
    source.emulatorSerials = [];
    await gate.assertCapacityAvailable();
    source.emulatorSerials = ["emulator-5554"];

    const error = (await rejection(
      gate.admit({ timeoutMs: 6_000, avdName: AVD }),
    )) as BootCapacityExhaustedError;

    expect(error.details.externalDevices).toEqual(["emulator-5554"]);
  });
});

describe("a serial handed off by a boot that ended unlisted is not ours (#11564)", () => {
  test("an external emulator that later takes the serial is named as external", async () => {
    const { timer, source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "1" });
    timer.enableAutoAdvance();
    const owned = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    owned.handOff("emulator-5554", 501);
    // The emulator exited during startup, before adb listed it.
    owned.release();
    owned.handOff("emulator-5554", 501);
    source.emulatorSerials = ["emulator-5554"];

    const error = (await rejection(
      gate.admit({ timeoutMs: 6_000, avdName: AVD }),
    )) as BootCapacityExhaustedError;

    expect(error.details.externalDevices).toEqual(["emulator-5554"]);
  });
});

describe("an emulator process adb does not list is added to admitted boots (#11564)", () => {
  test("an external unlisted emulator and an admitted boot that has not spawned are two", async () => {
    const { source, gate } = setup();
    // Started outside AutoMobile: its qemu process runs, adb does not list it yet.
    source.emulatorProcessRssBytes = [3 * GIB];
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });

    // The process is not the admitted boot's: that one has no process yet.
    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect(await rejection(gate.assertCapacityAvailable())).toBeInstanceOf(
      BootCapacityExhaustedError,
    );
    first.release();
    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });

  test("a spawned launcher that is not a qemu process yet is not matched to another emulator's process", async () => {
    const { source, gate } = setup();
    source.emulatorProcessRssBytes = [3 * GIB];
    source.emulatorProcessPids = [900];
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    // Handed off at spawn: the launcher runs, but the one qemu process is the external one.
    first.handOff("emulator-5556", 501);

    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("a boot spawned while the sample is being taken counts once when the sample shows its process", async () => {
    const { source, gate } = setup();
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    // The sample window is already open when the emulator spawns and `ps` then reads it.
    source.onSample = () => {
      first.handOff("emulator-5554", 501);
      source.emulatorProcessRssBytes = [3 * GIB];
      source.emulatorProcessPids = [501];
    };

    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });

  test("a qemu process whose parent is the spawned launcher is that boot's process", async () => {
    const { source, gate } = setup();
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554", 501);
    source.sample = async () => ({
      emulatorSerials: [],
      emulatorProcessRssBytes: [3 * GIB],
      emulatorProcessIds: [{ pid: 777, ppid: 501 }],
      host: source.host,
      errors: [],
    });

    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });

  test("a boot handed off without a pid is not matched to any process: fail closed", async () => {
    const { source, gate } = setup();
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554");
    source.emulatorProcessRssBytes = [3 * GIB];
    source.emulatorProcessPids = [501];

    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("two external unlisted emulators leave no room beside an unspawned boot at a limit of three", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "3" });
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB];
    await gate.admit({ timeoutMs: 60_000, avdName: AVD });

    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("steady state is not over-counted: listed emulators and launched boots each count once", async () => {
    const { source, gate } = setup({ [ANDROID_MAX_BOOTED_ENV]: "3" });
    // One external emulator, listed and in the process table.
    source.emulatorSerials = ["emulator-5554"];
    source.emulatorProcessRssBytes = [3 * GIB];
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5556", 502);
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB];
    source.emulatorProcessPids = [900, 502];

    // Two emulators run (one listed, one booting): a third still fits, a fourth does not.
    const second = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    expect(await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }))).toBeInstanceOf(
      BootCapacityExhaustedError,
    );

    // Everything booted and listed: three emulators, three processes, nothing in flight.
    second.handOff("emulator-5558", 503);
    source.emulatorSerials = ["emulator-5554", "emulator-5556", "emulator-5558"];
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB, 3 * GIB];
    source.emulatorProcessPids = [900, 502, 503];
    expect(await gate.describeCapacity()).toEqual({ limit: 3, booted: 3, inFlight: 0 });
    // One exits: exactly one slot is free again.
    source.emulatorSerials = ["emulator-5554", "emulator-5556"];
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB];
    source.emulatorProcessPids = [900, 502];
    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });
});

describe("a boot adb lists whose process the process table predates still counts (#11588)", () => {
  // `ps` was read before the admitted boot spawned and adb after it was listed: the table shows
  // only the external emulator, adb shows only the boot, and both run.
  function listedBootBesideExternalProcess(limit: string) {
    const context = setup({ [ANDROID_MAX_BOOTED_ENV]: limit });
    context.source.emulatorProcessRssBytes = [3 * GIB];
    context.source.emulatorProcessPids = [900];
    return context;
  }

  test("the boot and an external emulator only the process table shows are two", async () => {
    const { source, gate } = listedBootBesideExternalProcess("2");
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554", 501);
    source.emulatorSerials = ["emulator-5554"];

    const error = await rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect((error as BootCapacityExhaustedError).details.booted).toBe(2);
  });

  test("a read-only check and a report taken on such a sample do not hide the boot from an older open sample", async () => {
    const { source, gate } = listedBootBesideExternalProcess("2");
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554", 501);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = { ...(await source.sample()), emulatorSerials: ["emulator-5554"] };
    const fresh = source.sample.bind(source);
    // The older sample is still open when a reader's count sees the boot listed and ends its entry.
    source.sample = async () => {
      await held;
      return stale;
    };
    const pending = rejection(gate.admit({ timeoutMs: 60_000, avdName: AVD }));
    source.sample = fresh;
    source.emulatorSerials = ["emulator-5554"];
    source.emulatorProcessRssBytes = [3 * GIB, 3 * GIB];
    source.emulatorProcessPids = [900, 501];
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 2, inFlight: 0 });
    release();

    expect(await pending).toBeInstanceOf(BootCapacityExhaustedError);
  });

  test("steady state is not over-counted: once the table shows the boot's process it counts once", async () => {
    const { source, gate } = listedBootBesideExternalProcess("3");
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554", 501);
    source.emulatorSerials = ["emulator-5554"];
    // Table read before the spawn: the boot, the external emulator, and room for one more of three.
    const second = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    second.release();

    // Both reads now show the boot; the external emulator has exited. One of two slots is free.
    source.emulatorProcessRssBytes = [3 * GIB];
    source.emulatorProcessPids = [501];
    const tight = new AndroidBootAdmissionGate(source, new FakeTimer(), {
      env: { [ANDROID_MAX_BOOTED_ENV]: "2" },
    });
    (await tight.admit({ timeoutMs: 60_000, avdName: AVD })).release();
    expect(await gate.describeCapacity()).toEqual({ limit: 3, booted: 1, inFlight: 0 });
    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });

  test("a listed boot whose process the table shows is not added to it", async () => {
    const { source, gate } = setup();
    const first = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    first.handOff("emulator-5554", 501);
    source.emulatorSerials = ["emulator-5554"];
    source.emulatorProcessRssBytes = [3 * GIB];
    source.emulatorProcessPids = [501];

    (await gate.admit({ timeoutMs: 60_000, avdName: AVD })).release();
  });
});

test.each(["assertCapacityAvailable", "describeCapacity"] as const)(
  "%s bounds an abandoned sample, aborts it and closes its window",
  async (method) => {
    const { timer, source, gate } = setup();
    const original = source.sample.bind(source);
    let receivedSignal: AbortSignal | undefined;
    source.sample = (options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return new Promise(() => {});
    };
    let settled = false;
    const pending = gate[method]().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainUntilQuiescent(timer);
    await timer.advanceTimeAsync(DEFAULT_SAMPLE_TIMEOUT_MS, () => drainUntilQuiescent(timer));
    expect(settled).toBe(true); // Fails at once before the fix; never hangs awaiting an unbounded promise.
    expect(await pending).toMatchObject({
      code: "discovery_incomplete",
      retryable: true,
      discoveryError: { code: "timeout" },
    });
    expect(receivedSignal?.aborted).toBe(true);
    source.sample = original;
    const admission = await gate.admit({ timeoutMs: 60_000, avdName: AVD });
    admission.release();
    expect(await gate.describeCapacity()).toEqual({ limit: 2, booted: 0, inFlight: 0 });
  },
);

test.each(["assertCapacityAvailable", "describeCapacity"] as const)(
  "%s preserves caller abort and aborts its sample",
  async (method) => {
    const { timer, source, gate } = setup();
    let receivedSignal: AbortSignal | undefined;
    source.sample = (options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const reason = new Error("cancel check");
    let settled = false;
    const pending = gate[method]({ signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainUntilQuiescent(timer);
    controller.abort(reason);
    await drainUntilQuiescent(timer);
    expect(settled).toBe(true);
    expect(await pending).toBe(reason);
    expect(receivedSignal?.aborted).toBe(true);
  },
);
