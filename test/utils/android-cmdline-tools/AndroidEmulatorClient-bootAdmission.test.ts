import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, DeviceInfo, ExecResult } from "../../../src/models";
import type { AdmitColdBoot } from "../../../src/models/BootAdmission";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
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

function createChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new Readable({ read() {} }) as never;
  child.stderr = new Readable({ read() {} }) as never;
  child.killed = false;
  child.kill = (() => {
    child.killed = true;
    return true;
  }) as ChildProcess["kill"];
  return child;
}

function createClient(
  spawnFn: (command: string, args: string[]) => ChildProcess,
  bootedDevices: BootedDevice[] = [],
): AndroidEmulatorClient {
  const adb = new FakeAdbExecutor();
  adb.setDevices(bootedDevices);
  adb.setCommandResponse("emu avd name", execResult(`${AVD}\n`));
  const adbFactory: AdbClientFactory = { create: (): AdbExecutor => adb };
  const client = new AndroidEmulatorClient(
    async () => execResult(),
    spawnFn as never,
    new FakeTimer(),
    adbFactory,
    { readConfig: async () => ({ ramSizeMb: 2048 }) },
    undefined,
    undefined,
    { isPortAvailable: () => true },
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: AVD, platform: "android", isRunning: false },
  ];
  (client as unknown as { isAvdStarting: () => Promise<boolean> }).isAvdStarting = async () =>
    false;
  (
    client as unknown as { checkArchitectureCompatibility: () => Promise<{ compatible: boolean }> }
  ).checkArchitectureCompatibility = async () => ({ compatible: true });
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
  child: ChildProcess & EventEmitter;
} {
  const child = createChild();
  return {
    child,
    spawn: () => {
      events.push("spawn");
      queueMicrotask(() => child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n")));
      return child;
    },
  };
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
    expect(events[2]).toMatch(/^handOff:emulator-\d+$/);
    expect(events).toHaveLength(3);

    // The emulator dying before adb lists it frees the slot at once.
    child.emit("exit", 1, null);
    expect(events.at(-1)).toBe("release");
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
