import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { BootAdmission } from "../../../src/models/BootAdmission";
import { EmulatorLaunchCancelledError } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import {
  DefaultEmulatorLaunchCoordinator,
  type CoordinatorReservations,
} from "../../../src/utils/android-cmdline-tools/EmulatorLaunchCoordinator";
import { DefaultEmulatorLaunchTargets } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchTargets";
import type {
  EmulatorLauncher,
  EmulatorProcessLaunch,
  EmulatorProcessOptions,
} from "../../../src/utils/android-cmdline-tools/EmulatorLauncher";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

function child(): FakeChildProcess {
  const process = new FakeChildProcess(new FakeTimer());
  process.kill = () => {
    process.killed = true;
    return true;
  };
  return process;
}

class FakeLauncher implements EmulatorLauncher {
  readonly calls: { avdName: string; options?: EmulatorProcessOptions }[] = [];
  onStart: (options: EmulatorProcessOptions) => Promise<EmulatorProcessLaunch> = async () => ({
    process: null,
    outcome: "launched",
  });

  startEmulatorProcess(
    avdName: string,
    options?: EmulatorProcessOptions,
  ): Promise<EmulatorProcessLaunch> {
    this.calls.push({ avdName, options });
    return this.onStart(options ?? {});
  }
}

class FakeReservations implements CoordinatorReservations {
  reservedSerial: string | undefined;
  awaitingAdb: string | undefined;
  unreservedLaunch = false;
  readonly released: unknown[] = [];

  findReservedLaunchSerial(): string | undefined {
    return this.reservedSerial;
  }
  findLiveReservationAwaitingAdb(): string | undefined {
    return this.awaitingAdb;
  }
  hasLiveUnreservedLaunch(): boolean {
    return this.unreservedLaunch;
  }
  releasePendingEmulatorDeviceId(reservation: unknown): void {
    this.released.push(reservation);
  }
}

function setup(options: { posterExists?: boolean } = {}) {
  const launcher = new FakeLauncher();
  const reservations = new FakeReservations();
  const targets = new DefaultEmulatorLaunchTargets(() => ({
    recordReservedEmulatorDeviceId: () => {},
  }));
  const timer = new FakeTimer();
  let booted: BootedDevice[] = [];
  let starting = false;
  const coordinator = new DefaultEmulatorLaunchCoordinator({
    timer: () => timer,
    launcher: () => launcher,
    reservations: () => reservations,
    targets: () => targets,
    posterFileSystem: () => ({ existsSync: () => options.posterExists ?? true }),
    getBootedDevicesChecked: async () => booted,
    isAvdStarting: async () => starting,
  });
  return {
    coordinator,
    launcher,
    reservations,
    targets,
    setBooted: (devices: BootedDevice[]) => {
      booted = devices;
    },
    setStarting: (value: boolean) => {
      starting = value;
    },
  };
}

describe("DefaultEmulatorLaunchCoordinator.launchEmulator", () => {
  test("releasing a launch detaches its cancellation lifetime without killing the emulator", async () => {
    const { coordinator, launcher } = setup();
    const controller = new AbortController();
    const spawned = child();
    launcher.onStart = async () => ({ process: spawned, outcome: "launched" });
    const handle = await coordinator.launchEmulator({
      avdName: "Pixel",
      signal: controller.signal,
    });
    handle.release();
    handle.release();
    controller.abort(new Error("later reset failure"));
    expect(spawned.killed).toBe(false);
  });
  test("refuses launching an AVD already owned by another daemon", async () => {
    const { coordinator, launcher, setBooted } = setup();
    setBooted([
      { name: "Pixel", platform: "android", deviceId: "emulator-5556", foreignOwned: true },
    ]);
    await expect(
      coordinator.adoptsExistingAvdLaunch("Pixel", new NoOpPerformanceTracker()),
    ).rejects.toThrow(/another daemon.*Pixel/);
    expect(launcher.calls).toHaveLength(0);
  });

  test("an already aborted request is cancelled before launching", async () => {
    const { coordinator, launcher } = setup();
    const controller = new AbortController();
    controller.abort();
    const failure = await coordinator
      .launchEmulator({ avdName: "Pixel", signal: controller.signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmulatorLaunchCancelledError);
    expect(launcher.calls).toHaveLength(0);
  });

  test("hands the launcher the request and exposes the spawned process and expected serial", async () => {
    const { coordinator, launcher, targets } = setup();
    const spawned = child();
    launcher.onStart = async (options) => {
      options.onSpawn?.(spawned);
      return { process: spawned, outcome: "launched" };
    };
    const handle = await coordinator.launchEmulator({
      avdName: "Pixel",
      deviceId: "emulator-5554",
      extraArgs: ["-no-window"],
    });
    expect(handle.process).toBe(spawned);
    expect(handle.outcome).toBe("launched");
    expect(handle.targetDeviceId).toBe("emulator-5554");
    expect(targets.getLaunchTargetDeviceId(spawned)).toBe("emulator-5554");
    expect(launcher.calls[0]?.options).toMatchObject({
      requestedExtraArgs: ["-no-window"],
      expectedDeviceId: "emulator-5554",
      capturePreLaunchDeviceIds: true,
    });
  });

  test("only emulator-* or unknown serials request a pre-launch device snapshot", async () => {
    const { coordinator, launcher } = setup();
    await coordinator.launchEmulator({ avdName: "A", deviceId: "R58M123" });
    await coordinator.launchEmulator({ avdName: "B" });
    expect(launcher.calls.map((call) => call.options?.capturePreLaunchDeviceIds)).toEqual([
      false,
      true,
    ]);
  });

  test("disposing the handle terminates the child it created, once", async () => {
    const { coordinator, launcher } = setup();
    const spawned = child();
    let kills = 0;
    spawned.kill = () => {
      kills++;
      spawned.killed = true;
      return true;
    };
    launcher.onStart = async () => ({ process: spawned, outcome: "launched" });
    const handle = await coordinator.launchEmulator({ avdName: "Pixel" });
    handle.dispose();
    handle.dispose();
    expect(kills).toBe(1);
  });

  test("an abort during launch kills the spawned child and reports the cancellation with it", async () => {
    const { coordinator, launcher } = setup();
    const controller = new AbortController();
    const spawned = child();
    launcher.onStart = async (options) => {
      options.onSpawn?.(spawned);
      controller.abort();
      return { process: spawned, outcome: "launched" };
    };
    const failure = await coordinator
      .launchEmulator({ avdName: "Pixel", signal: controller.signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmulatorLaunchCancelledError);
    expect(spawned.killed).toBe(true);
  });

  test("a failed launch releases the boot admission and rethrows the failure", async () => {
    const { coordinator, launcher } = setup();
    let released = 0;
    const admission: BootAdmission = {
      release: () => {
        released++;
      },
      handOff: () => {},
    };
    launcher.onStart = async (options) => {
      options.onAdmitted?.(admission);
      throw new Error("spawn failed");
    };
    const failure = await coordinator.launchEmulator({ avdName: "Pixel" }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe("spawn failed");
    expect(released).toBe(1);
  });

  test("a camera poster must be a PNG or JPEG that exists", async () => {
    await expect(
      setup().coordinator.launchEmulator({ avdName: "P", cameraPosterPath: "/tmp/poster.gif" }),
    ).rejects.toThrow("cameraPosterPath must point to a PNG, JPG, or JPEG image.");
    await expect(
      setup({ posterExists: false }).coordinator.launchEmulator({
        avdName: "P",
        cameraPosterPath: "/tmp/poster.png",
      }),
    ).rejects.toThrow(`Camera poster image does not exist: ${resolve("/tmp/poster.png")}`);
  });

  test("a poster is refused when the launch adopted an existing process", async () => {
    const { coordinator } = setup();
    await expect(
      coordinator.launchEmulator({ avdName: "P", cameraPosterPath: "/tmp/poster.png" }),
    ).rejects.toThrow("cameraPosterPath is unsupported on a running or starting AVD");
  });
});

describe("DefaultEmulatorLaunchCoordinator.adoptsExistingAvdLaunch", () => {
  const perf = new NoOpPerformanceTracker();

  test("adopts an AVD that is already booted under that name", async () => {
    const ctx = setup();
    ctx.setBooted([{ name: "Pixel", deviceId: "emulator-5554", platform: "android" }]);
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(true);
  });

  test("adopts on a reserved console port, a pre-adb reservation, or an unreserved live launch", async () => {
    const ctx = setup();
    ctx.reservations.reservedSerial = "emulator-5554";
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(true);
    ctx.reservations.reservedSerial = undefined;
    ctx.reservations.awaitingAdb = "emulator-5556";
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(true);
    ctx.reservations.awaitingAdb = undefined;
    ctx.reservations.unreservedLaunch = true;
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(true);
  });

  test("adopts when the AVD is advertised as starting, otherwise spawns", async () => {
    const ctx = setup();
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(false);
    ctx.setStarting(true);
    expect(await ctx.coordinator.adoptsExistingAvdLaunch("Pixel", perf)).toBe(true);
  });
});

describe("DefaultEmulatorLaunchCoordinator cancellation helpers", () => {
  test("throwIfLaunchCancelled throws only when the launch was cancelled", () => {
    const { coordinator } = setup();
    expect(() => coordinator.throwIfLaunchCancelled("Pixel", () => false)).not.toThrow();
    expect(() => coordinator.throwIfLaunchCancelled("Pixel")).not.toThrow();
    expect(() => coordinator.throwIfLaunchCancelled("Pixel", () => true)).toThrow(
      EmulatorLaunchCancelledError,
    );
  });

  test("a cancelled launch frees its pending reservation before throwing", () => {
    const { coordinator, reservations } = setup();
    const reservation = {
      deviceId: "emulator-5554",
      ports: { consolePort: 5554, adbPort: 5555 },
      appendPort: true,
      avdName: "Pixel",
    };
    coordinator.releaseReservationIfLaunchCancelled("Pixel", reservation, () => false);
    expect(reservations.released).toEqual([]);
    expect(() =>
      coordinator.releaseReservationIfLaunchCancelled("Pixel", reservation, () => true),
    ).toThrow(EmulatorLaunchCancelledError);
    expect(reservations.released).toEqual([reservation]);
  });
});
