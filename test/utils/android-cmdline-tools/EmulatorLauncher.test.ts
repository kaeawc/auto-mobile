import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import {
  detectDeviceIdFromEmulatorOutput,
  launchFailureCategory,
  accelerationCheckCategory,
} from "../../../src/utils/android-cmdline-tools/emulatorLaunchFailure";
import type { HostChildProcess } from "../../../src/utils/HostCommandExecutor";
import type { DeviceInfo } from "../../../src/models";
import {
  DefaultEmulatorLauncher,
  type EmulatorLauncherHost,
} from "../../../src/utils/android-cmdline-tools/EmulatorLauncher";
import { EmulatorLaunchCancelledError } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import {
  DefaultEmulatorPortReservations,
  resetEmulatorLaunchReservations,
} from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakePortAvailabilityChecker } from "../../fakes/FakePortAvailabilityChecker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeEmulatorGrpcPortRegistry } from "../../fakes/FakeEmulatorGrpcPortRegistry";

let grpcPortRegistry: FakeEmulatorGrpcPortRegistry;
beforeEach(() => {
  grpcPortRegistry = new FakeEmulatorGrpcPortRegistry();
});

/** Members the launch pre-flight touches; everything else fails loudly if reached. */
function createHost(overrides: Partial<EmulatorLauncherHost>): EmulatorLauncherHost {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected host call: ${name}`);
  };
  return new Proxy(overrides as EmulatorLauncherHost, {
    get: (target, property: string) =>
      property in target ? target[property as keyof EmulatorLauncherHost] : unexpected(property),
  });
}

describe("DefaultEmulatorLauncher pre-flight", () => {
  let reservations: DefaultEmulatorPortReservations;

  beforeEach(() => {
    resetEmulatorLaunchReservations();
    const timer = new FakeTimer();
    reservations = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => new FakePortAvailabilityChecker(),
      grpcPortRegistry,
    });
  });

  const avds = (...names: string[]): DeviceInfo[] =>
    names.map((name) => ({ name, platform: "android" }) as DeviceInfo);

  test("refuses an AVD that does not exist and lists the available ones", async () => {
    const launcher = new DefaultEmulatorLauncher(
      createHost({
        reservations: () => reservations,
        listAvds: async () => avds("Pixel_9", "Tab"),
      }),
    );

    await expect(launcher.startEmulatorProcess("Missing")).rejects.toThrow(
      "AVD 'Missing' not found. Available AVDs: Pixel_9, Tab",
    );
  });

  test("joins a launch already in flight in this process without spawning", async () => {
    reservations.claimInFlightLaunch("Pixel_9");
    const posterChecks: Array<string | undefined> = [];
    const launcher = new DefaultEmulatorLauncher(
      createHost({
        reservations: () => reservations,
        listAvds: async () => avds("Pixel_9"),
        assertCameraPosterColdBoot: (posterPath) => {
          posterChecks.push(posterPath);
        },
      }),
    );

    const launch = await launcher.startEmulatorProcess("Pixel_9", { cameraPosterPath: "p.png" });

    expect(launch).toEqual({ process: null, outcome: "joined-in-process-launch" });
    expect(posterChecks).toEqual(["p.png"]);
  });
});

function startupHarness(
  probe: EmulatorLauncherHost["isEmulatorSerialListed"] = async () => false,
  onSpawn?: (args: readonly string[]) => void,
  throwIfLaunchCancelled: EmulatorLauncherHost["throwIfLaunchCancelled"] = () => {},
) {
  resetEmulatorLaunchReservations();
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const targets = new WeakMap<HostChildProcess, string>();
  const reservations = new DefaultEmulatorPortReservations({
    timer: () => timer,
    adbFactory: () => new FakeAdbClientFactory(),
    hostPortAvailabilityChecker: () => new FakePortAvailabilityChecker(),
    grpcPortRegistry,
  });
  reservations.addReservedEmulatorPort = async () => undefined;
  const overrides = {
    reservations: () => reservations,
    timer: () => timer,
    listAvds: async () => [{ name: "Pixel_9", platform: "android" } as DeviceInfo],
    adoptsExistingAvdLaunch: async () => false,
    avdConfigReader: () => new FakeAvdConfigReader(),
    validateAvdMemory: () => {},
    checkArchitectureCompatibility: async () => ({ compatible: true, hostArch: "arm64" }),
    emulatorAudioArguments: () => [],
    throwIfLaunchCancelled,
    releaseReservationIfLaunchCancelled: () => {},
    emulatorPath: () => "fake-emulator",
    spawnFn: () => (_command, args) => {
      onSpawn?.(args ?? []);
      return child;
    },
    launchTargetDeviceIds: () => targets,
    captureLaunchTargetDeviceId: (_child: HostChildProcess, output: string) => {
      const serial = detectDeviceIdFromEmulatorOutput(output);
      if (serial) {
        targets.set(child, serial);
      }
    },
    launchFailureCategory,
    accelerationCheckCategory,
    sandboxFailure: () => null,
    detectArchitecturePanic: () => ({ isPanic: false }),
    detectCorruptImage: () => ({ isCorrupt: false }),
    detectDisplayError: () => ({ isDisplayError: false }),
    isEmulatorSerialListed: probe,
  } satisfies Partial<EmulatorLauncherHost>;
  const launcher = new DefaultEmulatorLauncher(createHost(overrides));
  return { timer, child, launcher, reservations };
}

async function launchStartup(
  harness: ReturnType<typeof startupHarness>,
  expectedDeviceId?: string,
) {
  let result: HostChildProcess | null | undefined;
  const launch = harness.launcher
    .startEmulatorProcess("Pixel_9", { expectedDeviceId })
    .then((value) => {
      result = value.process;
      return value;
    });
  await drainUntil(() => harness.child.stdout.listenerCount("data") > 0, {
    description: "startup listeners",
  });
  return { launch, result: () => result };
}

function expectNoStartupTimers(timer: FakeTimer) {
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(timer.getPendingIntervalCount()).toBe(0);
}

test("wipe-data arguments append to operator GPU and memory arguments rather than replacing them", async () => {
  const previous = process.env.AUTOMOBILE_EMULATOR_ARGS;
  process.env.AUTOMOBILE_EMULATOR_ARGS = JSON.stringify([
    "-gpu",
    "swiftshader_indirect",
    "-memory",
    "4096",
  ]);
  const args: string[][] = [];
  const harness = startupHarness(
    async () => true,
    (spawnArgs) => {
      args.push([...spawnArgs]);
    },
  );
  try {
    const launch = harness.launcher.startEmulatorProcess("Pixel_9", {
      expectedDeviceId: "emulator-5554",
      requestedExtraArgs: ["-wipe-data", "-no-snapshot-load", "-no-snapshot-save"],
    });
    await drainUntil(() => harness.child.stdout.listenerCount("data") > 0, {
      description: "argument composition startup",
    });
    harness.child.stdout.emit("data", Buffer.from("emulator-5554"));
    await harness.timer.advanceTimeAsync(500);
    await launch;
    expect(args[0]).toEqual(
      expect.arrayContaining([
        "-gpu",
        "swiftshader_indirect",
        "-memory",
        "4096",
        "-wipe-data",
        "-no-snapshot-load",
        "-no-snapshot-save",
      ]),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_EMULATOR_ARGS;
    } else {
      process.env.AUTOMOBILE_EMULATOR_ARGS = previous;
    }
  }
});

describe("DefaultEmulatorLauncher early validation", () => {
  test("lists the expected serial on the second poll and clears every timer", async () => {
    const serials: string[] = [];
    const harness = startupHarness(async (serial) => {
      serials.push(serial);
      return serials.length === 2;
    });
    const pending = await launchStartup(harness, "emulator-5556");
    await harness.timer.advanceTimeAsync(500);
    expect(pending.result()).toBeUndefined();
    await harness.timer.advanceTimeAsync(500);
    expect(pending.result()).toBe(harness.child);
    expect(serials).toEqual(["emulator-5556", "emulator-5556"]);
    expect(harness.timer.now()).toBe(1000);
    expectNoStartupTimers(harness.timer);
    await harness.timer.advanceTimeAsync(5000);
    await pending.launch;
  });

  test("starts polling only after stdout captures a launch serial", async () => {
    const serials: string[] = [];
    const harness = startupHarness(async (serial) => {
      serials.push(serial);
      return true;
    });
    const pending = await launchStartup(harness);
    await harness.timer.advanceTimeAsync(500);
    expect(serials).toEqual([]);
    harness.child.stdout.emit(
      "data",
      readFileSync(
        new URL("../../fixtures/android-emulator/startup-console-port.txt", import.meta.url),
        "utf8",
      ),
    );
    await harness.timer.advanceTimeAsync(500);
    expect(pending.result()).toBe(harness.child);
    expect(serials).toEqual(["emulator-5556"]);
    expectNoStartupTimers(harness.timer);
    await harness.timer.advanceTimeAsync(5000);
    await pending.launch;
  });

  test("waits 1000 ms from the first stdout line without resetting on later lines", async () => {
    const harness = startupHarness();
    const pending = await launchStartup(harness);
    await harness.timer.advanceTimeAsync(200);
    harness.child.stdout.emit("data", "INFO | Android emulator version 36.1.9.0\n");
    await harness.timer.advanceTimeAsync(500);
    harness.child.stdout.emit("data", "INFO | initialization continues\n");
    await harness.timer.advanceTimeAsync(499);
    expect(pending.result()).toBeUndefined();
    await harness.timer.advanceTimeAsync(1);
    expect(pending.result()).toBe(harness.child);
    expect(harness.timer.now()).toBe(1200);
    expectNoStartupTimers(harness.timer);
    await harness.timer.advanceTimeAsync(5000);
    await pending.launch;
  });

  test("keeps the 5000 ms fallback without output or a known serial", async () => {
    let probes = 0;
    const harness = startupHarness(async () => {
      probes++;
      return true;
    });
    const pending = await launchStartup(harness);
    await harness.timer.advanceTimeAsync(4999);
    expect(pending.result()).toBeUndefined();
    await harness.timer.advanceTimeAsync(1);
    expect(pending.result()).toBe(harness.child);
    expect(probes).toBe(0);
    expectNoStartupTimers(harness.timer);
    await pending.launch;
  });
});

describe("early startup probe boundaries", () => {
  test("skips polling ticks while a serial probe is in flight", async () => {
    let probes = 0;
    let finishProbe!: (listed: boolean) => void;
    const harness = startupHarness(() => {
      probes++;
      return new Promise<boolean>((resolve) => {
        finishProbe = resolve;
      });
    });
    const pending = await launchStartup(harness, "emulator-5556");
    await harness.timer.advanceTimeAsync(1500);
    expect(probes).toBe(1);
    expect(pending.result()).toBeUndefined();
    finishProbe(true);
    await harness.timer.advanceTimeAsync(0);
    await drainUntil(() => pending.result() !== undefined, { description: "serial completion" });
    expect(pending.result()).toBe(harness.child);
    expectNoStartupTimers(harness.timer);
    await pending.launch;
  });

  test("ignores a late serial result after stdout grace completes", async () => {
    let finishProbe!: (listed: boolean) => void;
    const harness = startupHarness(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const pending = await launchStartup(harness, "emulator-5556");
    harness.child.stdout.emit("data", "INFO | booting\n");
    await harness.timer.advanceTimeAsync(1000);
    expect(pending.result()).toBe(harness.child);
    expectNoStartupTimers(harness.timer);
    finishProbe(true);
    await harness.timer.advanceTimeAsync(5000);
    expectNoStartupTimers(harness.timer);
    await pending.launch;
  });

  test("stderr and partial stdout do not start the first-line grace", async () => {
    const harness = startupHarness();
    const pending = await launchStartup(harness);
    harness.child.stderr.emit("data", "INFO | stderr boot message\n");
    harness.child.stdout.emit("data", "INFO | partial stdout");
    await harness.timer.advanceTimeAsync(1000);
    expect(pending.result()).toBeUndefined();
    harness.child.stdout.emit("data", " line\n");
    await harness.timer.advanceTimeAsync(999);
    expect(pending.result()).toBeUndefined();
    await harness.timer.advanceTimeAsync(1);
    expect(pending.result()).toBe(harness.child);
    expectNoStartupTimers(harness.timer);
    await pending.launch;
  });

  for (const failure of [
    "Running multiple emulators with the same AVD\n",
    "ProbeKVM: Could not open /dev/kvm: Permission denied\n",
    "hardware acceleration is not available on this host\n",
  ]) {
    test(`suppresses early signals after ${failure.trim()}`, async () => {
      const harness = startupHarness(async () => true);
      const pending = await launchStartup(harness);
      harness.child.stdout.emit("data", "INFO | booting\n");
      await harness.timer.advanceTimeAsync(500);
      harness.child.stderr.emit(
        "data",
        "emulator: Android emulator console on port 5556\n" + failure,
      );
      await harness.timer.advanceTimeAsync(500);
      expect(pending.result()).toBeUndefined();
      expect(harness.timer.getPendingIntervals()).toEqual([]);
      expect(harness.timer.getPendingTimeouts()).toEqual([5000]);
      await harness.timer.advanceTimeAsync(4000);
      expect(pending.result()).toBe(harness.child);
      expectNoStartupTimers(harness.timer);
      await pending.launch;
    });
  }
});

describe("existing stdout startup markers", () => {
  for (const marker of ["INFO         | emuDirName:", "Hax is enabled", "Detected GPU type"]) {
    test(`${marker} still resolves immediately and clears grace and polling timers`, async () => {
      const harness = startupHarness();
      const pending = await launchStartup(harness, "emulator-5556");
      harness.child.stdout.emit("data", "INFO | booting\n");
      await harness.timer.advanceTimeAsync(750);
      expect(pending.result()).toBeUndefined();
      harness.child.stdout.emit("data", marker);
      expect((await pending.launch).process).toBe(harness.child);
      expect(harness.timer.now()).toBe(750);
      expectNoStartupTimers(harness.timer);
    });
  }
});

describe("DefaultEmulatorLauncher gRPC port", () => {
  test("spawn failure releases the gRPC lease", async () => {
    const harness = startupHarness(
      async () => false,
      () => {
        throw new Error("spawn failed");
      },
    );
    await expect(harness.launcher.startEmulatorProcess("Pixel_9")).rejects.toThrow("spawn failed");
    expect((await harness.reservations.reserveEmulatorGrpcPort()).port).toBe(8554);
  });

  test("pre-spawn cancellation releases the gRPC lease on consecutive launches", async () => {
    let spawned = false;
    const harness = startupHarness(
      async () => false,
      () => {
        spawned = true;
      },
      (avdName, isCancelled) => {
        if (isCancelled?.()) {
          throw new EmulatorLaunchCancelledError(avdName, null);
        }
      },
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        harness.launcher.startEmulatorProcess("Pixel_9", { isCancelled: () => true }),
      ).rejects.toThrow(EmulatorLaunchCancelledError);
      const lease = await harness.reservations.reserveEmulatorGrpcPort();
      try {
        expect(lease.port).toBe(8554);
      } finally {
        lease.release();
      }
    }
    expect(spawned).toBe(false);
    expectNoStartupTimers(harness.timer);
  });

  async function bootStartup(extraArgs?: string[]) {
    const args: string[][] = [];
    const harness = startupHarness(
      async () => true,
      (spawnArgs) => {
        args.push([...spawnArgs]);
      },
    );
    const launch = harness.launcher.startEmulatorProcess("Pixel_9", {
      expectedDeviceId: "emulator-5554",
      requestedExtraArgs: extraArgs,
    });
    await drainUntil(() => harness.child.stdout.listenerCount("data") > 0, {
      description: "grpc port startup",
    });
    harness.child.stdout.emit("data", Buffer.from("emulator-5554"));
    await harness.timer.advanceTimeAsync(500);
    await launch;
    return { args: args[0], child: harness.child };
  }

  test("a daemon-booted emulator is launched with a leased -grpc port", async () => {
    const { args } = await bootStartup();
    const index = args.indexOf("-grpc");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("8554");
  });

  test("a caller-supplied -grpc port is passed through and no second port is added", async () => {
    const { args } = await bootStartup(["-grpc", "8600"]);
    expect(args.filter((arg) => arg === "-grpc" || arg.startsWith("-grpc="))).toEqual(["-grpc"]);
    expect(args[args.indexOf("-grpc") + 1]).toBe("8600");
  });

  test("a running emulator keeps its gRPC port leased from other launches", async () => {
    await bootStartup();

    const reservations = new DefaultEmulatorPortReservations({
      timer: () => new FakeTimer(),
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => new FakePortAvailabilityChecker(),
      grpcPortRegistry,
    });
    expect((await reservations.reserveEmulatorGrpcPort()).port).toBe(8555);
  });
});
