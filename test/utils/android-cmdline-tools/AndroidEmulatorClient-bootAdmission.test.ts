import { afterEach, describe, expect, test } from "bun:test";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import type { ChildProcess } from "node:child_process";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { AdmitColdBoot } from "../../../src/models/BootAdmission";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const AVD = "Pixel 9";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

function createChild(): FakeChildProcess {
  return new FakeChildProcess();
}

function createClient(
  spawnFn: (command: string, args: string[]) => ChildProcess,
  bootedDevices: BootedDevice[] = [],
): AndroidEmulatorClient {
  const adb = new FakeAdbExecutor();
  adb.setDevices(bootedDevices);
  adb.setCommandResponse("emu avd name", execResult(`${AVD}\n`));
  const adbFactory: AdbClientFactory = { create: (): AdbExecutor => adb };
  const client = new AndroidEmulatorClient({
    emulatorPathLocator: async () => "emulator",
    execAsync: async () => execResult(),
    spawnFn,
    timer: new FakeTimer(),
    adbFactory,
    avdConfigReader: { readConfig: async () => ({ ramSizeMb: 2048 }) },
    hostPortAvailabilityChecker: { isPortAvailable: () => true },
  });
  client.listAvds = async () => [{ name: AVD, platform: "android", isRunning: false }];
  client.isAvdStarting = async () => false;
  client.checkArchitectureCompatibility = async () => ({ compatible: true, hostArch: "arm64" });
  return client;
}

/** Records the admission lifecycle alongside the spawn, in order; idempotent like the real one. */
function recordingAdmission(events: string[]): AdmitColdBoot {
  return async () => {
    events.push("admit");
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          events.push("release");
        }
      },
      handOff: (deviceId) => events.push(`handOff:${deviceId}`),
    };
  };
}

function spawnReportingStartup(events: string[]): {
  spawn: (command: string, args: string[]) => ChildProcess;
  child: FakeChildProcess;
} {
  const child = createChild();
  return {
    child,
    spawn: () => {
      events.push("spawn");
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    },
  };
}

/** Lets the launch run, without a timer, until `event` was recorded. */
async function waitForEvent(events: string[], event: string): Promise<void> {
  for (let turn = 0; turn < 200 && !events.includes(event); turn++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
});

describe("AndroidEmulatorClient boot admission (#11181)", () => {
  test("admits before the cold spawn and hands the slot off to the reserved serial", async () => {
    const events: string[] = [];
    const { spawn, child } = spawnReportingStartup(events);
    const client = createClient(spawn);

    const launch = await client.launchEmulator({
      avdName: AVD,
      admitColdBoot: recordingAdmission(events),
    });

    expect(launch.outcome).toBe("launched");
    expect(events[0]).toBe("admit");
    expect(events[1]).toBe("spawn");
    // Handed off at the spawn, and again with the same serial once startup validation ended.
    expect(events[2]).toMatch(/^handOff:emulator-\d+$/);
    expect(events.slice(3)).toEqual([events[2]]);

    // The emulator dying before adb lists it frees the slot at once.
    child.emit("exit", 1, null);
    expect(events.at(-1)).toBe("release");
  });

  test("hands the slot off as soon as the process exists, before startup validation ends (#11564)", async () => {
    const events: string[] = [];
    const child = createChild();
    const client = createClient(() => {
      events.push("spawn");
      return child;
    });

    const launching = client.launchEmulator({
      avdName: AVD,
      admitColdBoot: recordingAdmission(events),
    });
    // Startup validation is still waiting for the emulator's first output.
    await waitForEvent(events, "spawn");

    expect(events).toEqual(["admit", "spawn", expect.stringMatching(/^handOff:emulator-\d+$/)]);

    child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    await launching;
    expect(events).toEqual(["admit", "spawn", events[2], events[2]]);
  });

  test("an emulator that exits during startup validation frees its slot once (#11564)", async () => {
    const events: string[] = [];
    const child = createChild();
    const client = createClient(() => {
      events.push("spawn");
      return child;
    });

    const launching = client.launchEmulator({
      avdName: AVD,
      admitColdBoot: recordingAdmission(events),
    });
    await waitForEvent(events, "spawn");
    child.emit("exit", 1, null);
    // Freed by the exit itself, not by the launch failing once the stdio has drained.
    expect(events.at(-1)).toBe("release");
    child.emit("close", 1, null);

    await expect(launching).rejects.toThrow();
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    expect(events.filter((event) => event.startsWith("handOff"))).toHaveLength(1);
  });

  test("a failed spawn releases the slot and never hands it off", async () => {
    const events: string[] = [];
    const client = createClient(() => {
      events.push("spawn");
      throw new Error("spawn ENOENT");
    });

    await expect(
      client.launchEmulator({ avdName: AVD, admitColdBoot: recordingAdmission(events) }),
    ).rejects.toThrow("spawn ENOENT");

    expect(events).toEqual(["admit", "spawn", "release"]);
  });

  test("a refused admission surfaces its typed error without spawning", async () => {
    let spawns = 0;
    const client = createClient(() => {
      spawns++;
      return createChild();
    });
    const refusal = new BootCapacityExhaustedError(
      { platform: "android", limit: 1, booted: 1, retryAfterMs: 5_000 },
      "no capacity",
    );

    await expect(
      client.launchEmulator({
        avdName: AVD,
        admitColdBoot: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(spawns).toBe(0);
  });

  test("adopting an AVD that is already running never asks for admission", async () => {
    const events: string[] = [];
    const client = createClient(() => {
      throw new Error("must not spawn");
    }, [{ name: AVD, platform: "android", deviceId: "emulator-5554", source: "local" }]);

    const launch = await client.launchEmulator({
      avdName: AVD,
      admitColdBoot: recordingAdmission(events),
    });

    expect(launch.outcome).toBe("already-running");
    expect(events).toEqual([]);
  });

  test("a launch cancelled after admission releases its slot", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const client = createClient(() => {
      throw new Error("must not spawn");
    });

    await expect(
      client.launchEmulator({
        avdName: AVD,
        signal: controller.signal,
        admitColdBoot: async () => {
          const admission = await recordingAdmission(events)();
          controller.abort();
          return admission;
        },
      }),
    ).rejects.toThrow();

    expect(events).toEqual(["admit", "release"]);
  });
});

// #11593: what a cancelled launch leaves in the REAL gate and ledger, at a limit of one emulator.
describe("AndroidEmulatorClient cancelled launches against the real boot admission gate", () => {
  const realGate = (): {
    gate: AndroidBootAdmissionGate;
    source: FakeAndroidCapacitySource;
    admitColdBoot: AdmitColdBoot;
    releases: () => number;
    handedOffSerial: () => string | undefined;
  } => {
    const source = new FakeAndroidCapacitySource();
    const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), {
      env: { [ANDROID_MAX_BOOTED_ENV]: "1" },
    });
    let releaseCalls = 0;
    let serial: string | undefined;
    return {
      gate,
      source,
      releases: () => releaseCalls,
      handedOffSerial: () => serial,
      admitColdBoot: async () => {
        const admission = await gate.admit({ avdName: AVD, timeoutMs: 120_000 });
        return {
          handOff: (deviceId) => {
            serial = deviceId;
            admission.handOff(deviceId);
          },
          release: () => {
            releaseCalls++;
            admission.release();
          },
        };
      },
    };
  };

  /** Whether a second caller's cold boot is admitted now; its slot is handed back at once. */
  const secondBootAdmitted = async (gate: AndroidBootAdmissionGate): Promise<boolean> => {
    try {
      (await gate.admit({ avdName: "second", timeoutMs: 120_000 })).release();
      return true;
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        return false;
      }
      throw error;
    }
  };

  test("cancelled between the admission and the spawn: the slot is freed once and a second boot fits", async () => {
    const { gate, admitColdBoot, releases } = realGate();
    const controller = new AbortController();
    const client = createClient(() => {
      throw new Error("must not spawn");
    });

    await expect(
      client.launchEmulator({
        avdName: AVD,
        signal: controller.signal,
        admitColdBoot: async () => {
          const admission = await admitColdBoot();
          controller.abort();
          return admission;
        },
      }),
    ).rejects.toThrow();

    expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 0 });
    expect(await secondBootAdmitted(gate)).toBe(true);
    // However many layers reported the cancellation, a second caller's slot is not freed by it.
    expect(releases()).toBeGreaterThanOrEqual(1);
    const second = await gate.admit({ avdName: "second", timeoutMs: 120_000 });
    expect(await secondBootAdmitted(gate)).toBe(false);
    second.release();
  });

  test("stopped between the spawn and adb listing it: counted until the process exits, then freed once", async () => {
    const { gate, source, admitColdBoot } = realGate();
    // No process table: only the admission itself can count a boot adb does not list yet.
    source.emulatorProcessRssBytes = undefined;
    source.serialListingError = undefined;
    const { spawn, child } = spawnReportingStartup([]);
    const client = createClient(spawn);

    const launch = await client.launchEmulator({ avdName: AVD, admitColdBoot });
    expect(launch.outcome).toBe("launched");

    expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 1 });
    expect(await secondBootAdmitted(gate)).toBe(false);

    // The undo signals the emulator; until it is gone it keeps its slot.
    child.kill();
    expect(await secondBootAdmitted(gate)).toBe(false);
    child.emit("exit", 0, "SIGTERM");

    expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 0 });
    const second = await gate.admit({ avdName: "second", timeoutMs: 120_000 });
    // A second exit report from the stopped emulator frees nothing of the second caller's.
    child.emit("exit", 0, "SIGTERM");
    expect(await gate.describeCapacity()).toMatchObject({ inFlight: 1 });
    expect(await secondBootAdmitted(gate)).toBe(false);
    second.release();
  });

  test("an emulator the stop could not kill, listed by adb, holds its slot through the listing alone", async () => {
    const { gate, source, admitColdBoot, handedOffSerial } = realGate();
    const { spawn, child } = spawnReportingStartup([]);
    const client = createClient(spawn);
    const launch = await client.launchEmulator({ avdName: AVD, admitColdBoot });
    expect(launch.outcome).toBe("launched");
    source.emulatorSerials = [handedOffSerial()!];
    source.emulatorProcessRssBytes = [1024 ** 3];

    child.kill();

    expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
    expect(await secondBootAdmitted(gate)).toBe(false);

    source.emulatorSerials = [];
    source.emulatorProcessRssBytes = [];
    child.emit("exit", 0, "SIGKILL");

    expect(await gate.describeCapacity()).toMatchObject({ booted: 0, inFlight: 0 });
    expect(await secondBootAdmitted(gate)).toBe(true);
  });
});
