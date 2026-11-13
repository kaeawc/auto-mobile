import { FakeAvdColdBootMarkerStore } from "../../fakes/FakeAvdColdBootMarkerStore";
import { PendingColdBootMarkerClears } from "../../../src/utils/android-cmdline-tools/PendingColdBootMarkerClears";
import { FakeNetsimInstanceLauncher } from "../../fakes/FakeNetsimInstanceLauncher";
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
import { ActionableError, type DeviceInfo } from "../../../src/models";
import { formatEarlyExitError } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchDiagnostics";
import {
  DefaultEmulatorLauncher,
  type EmulatorLauncherHost,
} from "../../../src/utils/android-cmdline-tools/EmulatorLauncher";
import { EmulatorLaunchCancelledError } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchCancelledError";
import {
  DefaultEmulatorPortReservations,
  type EmulatorDeviceIdReservation,
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
import { defaultEmulatorOutputTail } from "../../../src/utils/android-cmdline-tools/EmulatorOutputTail";
import { EmulatorAudioService } from "../../../src/features/audio/EmulatorAudioService";
import { FakeEmulatorAudioSession } from "../../fakes/FakeEmulatorAudioSession";
import { FakeGuestAudioCapture } from "../../fakes/FakeGuestAudioCapture";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";

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
  hostOverrides: Partial<EmulatorLauncherHost> = {},
) {
  resetEmulatorLaunchReservations();
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const netsim = new FakeNetsimInstanceLauncher();
  const targets = new WeakMap<HostChildProcess, string>();
  const errors = new WeakMap<HostChildProcess, ActionableError>();
  const finalizations = new WeakMap<HostChildProcess, Promise<ActionableError | undefined>>();
  const reservations = new DefaultEmulatorPortReservations({
    timer: () => timer,
    adbFactory: () => new FakeAdbClientFactory(),
    hostPortAvailabilityChecker: () => new FakePortAvailabilityChecker(),
    grpcPortRegistry,
  });
  reservations.addReservedEmulatorPort = async () => undefined;
  const defaultMarkers = new FakeAvdColdBootMarkerStore();
  const coldBootClears = new PendingColdBootMarkerClears(() =>
    (hostOverrides.avdColdBootMarkers ?? (() => defaultMarkers))(),
  );
  const overrides = {
    reservations: () => reservations,
    timer: () => timer,
    listAvds: async () => [{ name: "Pixel_9", platform: "android" } as DeviceInfo],
    adoptsExistingAvdLaunch: async () => false,
    avdConfigReader: () => new FakeAvdConfigReader(),
    validateAvdMemory: () => {},
    checkArchitectureCompatibility: async () => ({ compatible: true, hostArch: "arm64" }),
    emulatorAudioArguments: () => [],
    netsimInstanceLauncher: () => netsim,
    avdColdBootMarkers: () => defaultMarkers,
    pendingColdBootMarkerClears: () => coldBootClears,
    throwIfLaunchCancelled,
    releaseReservationIfLaunchCancelled: () => {},
    emulatorPath: () => "fake-emulator",
    spawnFn: () => (_command, args) => {
      onSpawn?.(args ?? []);
      return child;
    },
    launchTargetDeviceIds: () => targets,
    launchErrors: () => errors,
    launchErrorFinalizations: () => finalizations,
    formatEarlyExitError,
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
  const launcher = new DefaultEmulatorLauncher(createHost({ ...overrides, ...hostOverrides }));
  return { timer, child, launcher, reservations, netsim, coldBootClears };
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

for (const stream of ["stdout", "stderr"] as const) {
  for (const afterStartup of [false, true]) {
    test(`refuses injection after host failure and log churn on ${stream}, afterStartup=${afterStartup}`, async () => {
      const harness = startupHarness();
      const { launch } = await launchStartup(harness, "emulator-5554");
      if (afterStartup) {
        harness.timer.advanceTime(5_000);
        await launch;
      }
      const pid = harness.child.pid;
      if (pid === undefined) {
        throw new Error("Fake child must have a PID");
      }
      harness.child[stream].emit("data", Buffer.from("Could not initialize record\n"));
      const info = `INFO | ${"ordinary output ".repeat(24)}\n`;
      expect(Buffer.byteLength(info) * 60).toBeGreaterThan(16 * 1024);
      for (let line = 0; line < 60; line++) {
        harness.child[stream].emit("data", Buffer.from(info));
      }
      expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).not.toContain(
        "Could not initialize record",
      );
      const endpoint = {
        pid,
        consolePort: 5554,
        address: "localhost:8554",
        auth: { kind: "none" },
        descriptionFile: `pid_${pid}.ini`,
      } as const;
      const session = new FakeEmulatorAudioSession(endpoint);
      const guestCapture = new FakeGuestAudioCapture();
      const service = new EmulatorAudioService({
        discovery: { findByConsolePort: async () => endpoint },
        outputTail: defaultEmulatorOutputTail,
        guestCapture,
        createSession: () => session,
        readFile: async () => new Uint8Array(),
        ids: new CountingIdGenerator("churn"),
      });
      if (!afterStartup) {
        harness.timer.advanceTime(5_000);
        await launch;
      }
      await expect(
        service.startInjection("emulator-5554", { source: { kind: "tone", durationMs: 1 } }),
      ).rejects.toMatchObject({ code: "audio_host_microphone_unavailable" });
      expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(true);
      expect(guestCapture.opened).toEqual([]);
      expect(session.injected).toEqual([]);
      expectNoStartupTimers(harness.timer);
    });
  }
}

test("indexes redacted stdout and stderr throughout the launch and prunes on exit", async () => {
  const harness = startupHarness();
  const { launch } = await launchStartup(harness, "emulator-5554");
  const pid = harness.child.pid;
  if (pid === undefined) {
    throw new Error("Fake child must have a PID");
  }
  harness.child.stdout.emit("data", Buffer.from("coreaudio: Could not initialize record\n"));
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(true);
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).toContain(
    "Could not initialize record",
  );
  harness.timer.advanceTime(5_000);
  await launch;
  // Short, chunk-split output is visible through safe redactor snapshots after startup too.
  harness.child.stderr.emit("data", Buffer.from("\ntoken=private-"));
  harness.child.stderr.emit("data", Buffer.from("credential\nFailed to create voice virtio-"));
  harness.child.stderr.emit("data", Buffer.from("snd-mic0\n"));
  const output = defaultEmulatorOutputTail.tailFor("emulator-5554", pid);
  expect(output).toContain("Failed to create voice virtio-snd-mic0");
  expect(output).not.toContain("private-");
  expect(output).not.toContain("credential");
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid + 1)).toBeUndefined();
  expect(defaultEmulatorOutputTail.tailFor("emulator-5556", pid)).toBeUndefined();
  // A real ChildProcess sets exitCode before it emits exit.
  harness.child.exitCode = 0;
  harness.child.emit("exit", 0, null);
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(false);
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).toBeUndefined();
  // Draining stdio after exit cannot re-register this incarnation.
  harness.child.stderr.emit("data", Buffer.from("late output\n"));
  harness.child.emit("close", 0, null);
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).toBeUndefined();
});

test("latches a failure in a single chunk larger than the diagnostic tail", async () => {
  const harness = startupHarness();
  const { launch } = await launchStartup(harness, "emulator-5554");
  const pid = harness.child.pid;
  if (pid === undefined) {
    throw new Error("Fake child must have a PID");
  }
  harness.child.stdout.emit(
    "data",
    Buffer.from("Could not initialize record\n" + "INFO | ordinary output\n".repeat(2_000)),
  );
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).not.toContain(
    "Could not initialize record",
  );
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(true);
  harness.timer.advanceTime(5_000);
  await launch;
});

test("latches a short chunk-split post-startup failure and ignores stale output after exit", async () => {
  const harness = startupHarness();
  const { launch } = await launchStartup(harness, "emulator-5554");
  harness.timer.advanceTime(5_000);
  await launch;
  const pid = harness.child.pid;
  if (pid === undefined) {
    throw new Error("Fake child must have a PID");
  }
  harness.child.stderr.emit("data", Buffer.from("Failed to create voice virtio-"));
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(false);
  harness.child.stderr.emit("data", Buffer.from("snd-mic0\n"));
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(true);
  harness.child.exitCode = 0;
  harness.child.emit("exit", 0, null);
  // Re-register without a lookup in between: exit must have removed the old source and latch.
  const remove = defaultEmulatorOutputTail.register(pid, {
    deviceId: () => "emulator-5554",
    snapshot: () => "replacement incarnation",
  });
  harness.child.stderr.emit("data", Buffer.from("Could not initialize record\n"));
  harness.child.emit("close", 0, null);
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(false);
  expect(defaultEmulatorOutputTail.tailFor("emulator-5554", pid)).toBe("replacement incarnation");
  remove();
});

test("keeps stderr failure text adjacent to its own redactor suffix while stdout is pending", async () => {
  const harness = startupHarness();
  const { launch } = await launchStartup(harness, "emulator-5554");
  harness.timer.advanceTime(5_000);
  await launch;
  const pid = harness.child.pid;
  if (pid === undefined) {
    throw new Error("Fake child must have a PID");
  }
  harness.child.stdout.emit("data", Buffer.from("INFO | unrelated stdout\n"));
  harness.child.stderr.emit("data", Buffer.from("Could not initialize record\n" + " ".repeat(120)));
  expect(defaultEmulatorOutputTail.hostMicrophoneFailed("emulator-5554", pid)).toBe(true);
});

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

for (const enabled of [undefined, "false", "1", "TRUE", " true ", "true"]) {
  test(`private netsimd opt-in requires exact true: ${enabled}`, async () => {
    const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    const previousArgs = process.env.AUTOMOBILE_EMULATOR_ARGS;
    const previousHeadless = process.env.AUTOMOBILE_EMULATOR_HEADLESS;
    try {
      delete process.env.AUTOMOBILE_EMULATOR_ARGS;
      process.env.AUTOMOBILE_EMULATOR_HEADLESS = "true";
      if (enabled === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = enabled;
      }
      let args: readonly string[] = [];
      const h = startupHarness(undefined, (spawnArgs) => {
        args = [...spawnArgs];
      });
      const { launch } = await launchStartup(h);
      expect(h.netsim.starts).toBe(enabled === "true" ? 1 : 0);
      expect(args).toEqual([
        "-avd",
        "Pixel_9",
        "-no-window",
        "-grpc",
        "8554",
        ...(enabled === "true" ? ["-packet-streamer-endpoint", "localhost:53078"] : []),
      ]);
      h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
      await launch;
      expect(h.netsim.stops).toBe(0);
      h.child.emit("exit", 0, null);
      expect(h.netsim.stops).toBe(enabled === "true" ? 1 : 0);
      h.child.emit("close", 0, null);
      expectNoStartupTimers(h.timer);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
      }
      if (previousArgs === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_ARGS;
      } else {
        process.env.AUTOMOBILE_EMULATOR_ARGS = previousArgs;
      }
      if (previousHeadless === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_HEADLESS;
      } else {
        process.env.AUTOMOBILE_EMULATOR_HEADLESS = previousHeadless;
      }
    }
  });
}

for (const endpointArgs of [
  ["-packet-streamer-endpoint", "localhost:1234"],
  ["-packet-streamer-endpoint=localhost:1234"],
]) {
  test(`explicit endpoint bypasses private netsimd: ${endpointArgs[0]}`, async () => {
    const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    const previousArgs = process.env.AUTOMOBILE_EMULATOR_ARGS;
    try {
      process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = "true";
      process.env.AUTOMOBILE_EMULATOR_ARGS = JSON.stringify(endpointArgs);
      let args: readonly string[] = [];
      const h = startupHarness(undefined, (spawnArgs) => {
        args = [...spawnArgs];
      });
      const { launch } = await launchStartup(h);
      expect(h.netsim.starts).toBe(0);
      expect(args).toEqual(expect.arrayContaining(endpointArgs));
      h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
      await launch;
      h.child.emit("exit", 0, null);
      h.child.emit("close", 0, null);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
      }
      if (previousArgs === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_ARGS;
      } else {
        process.env.AUTOMOBILE_EMULATOR_ARGS = previousArgs;
      }
    }
  });
}

for (const failure of ["spawn", "exit", "duplicate", "netsimd"] as const) {
  test(`private netsimd cleanup on ${failure}`, async () => {
    const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    try {
      process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = "true";
      const h = startupHarness(undefined, () => {
        if (failure === "spawn") {
          throw new Error("spawn refused");
        }
      });
      if (failure === "netsimd") {
        h.netsim.error = new ActionableError("netsimd refused");
      }
      const launch = h.launcher.startEmulatorProcess("Pixel_9");
      if (failure === "spawn" || failure === "netsimd") {
        await expect(launch).rejects.toThrow(
          failure === "spawn" ? "spawn refused" : "netsimd refused",
        );
      } else {
        await drainUntil(() => h.child.stdout.listenerCount("data") > 0, {
          description: "startup listeners",
        });
        if (failure === "duplicate") {
          h.child.stderr.emit("data", Buffer.from("Running multiple emulators with the same AVD"));
        }
        h.child.emit("exit", 1, null);
        h.child.emit("close", 1, null);
        if (failure === "duplicate") {
          expect(await launch).toEqual({ process: null, outcome: "duplicate-of-external" });
        } else {
          await expect(launch).rejects.toThrow();
        }
      }
      expect(h.netsim.stops).toBe(failure === "netsimd" ? 0 : 1);
      expect(h.reservations.hasInFlightLaunch("Pixel_9")).toBe(false);
      expectNoStartupTimers(h.timer);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
      }
    }
  });
}

for (const failure of ["netsimd", "spawn"] as const) {
  test(`reserved console ports are released exactly once on ${failure} failure`, async () => {
    const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    try {
      process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = "true";
      const h = startupHarness(undefined, () => {
        throw new Error("spawn refused");
      });
      const reservation: EmulatorDeviceIdReservation = {
        deviceId: "emulator-5580",
        ports: { consolePort: 5580, adbPort: 5581 },
        appendPort: true,
        avdName: "Pixel_9",
      };
      h.reservations.addReservedEmulatorPort = async () => reservation;
      const released: EmulatorDeviceIdReservation[] = [];
      h.reservations.releasePendingEmulatorDeviceId = (pending) => {
        released.push(pending);
      };
      if (failure === "netsimd") {
        h.netsim.error = new ActionableError("netsimd refused");
      }
      await expect(h.launcher.startEmulatorProcess("Pixel_9")).rejects.toThrow(
        failure === "netsimd" ? "netsimd refused" : "spawn refused",
      );
      expect(released).toEqual([reservation]);
      expectNoStartupTimers(h.timer);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
      }
    }
  });
}

for (const outcome of ["joined-in-process-launch", "already-running"] as const) {
  test(`private netsimd is not started for ${outcome}`, async () => {
    const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    try {
      process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = "true";
      const h = startupHarness(undefined, undefined, undefined, {
        adoptsExistingAvdLaunch: async () => outcome === "already-running",
        assertCameraPosterColdBoot: () => {},
      });
      if (outcome === "joined-in-process-launch") {
        h.reservations.claimInFlightLaunch("Pixel_9");
      }
      expect(await h.launcher.startEmulatorProcess("Pixel_9")).toEqual({ process: null, outcome });
      expect(h.netsim.starts).toBe(0);
      expectNoStartupTimers(h.timer);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
      } else {
        process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
      }
    }
  });
}

test("private netsimd starts only after boot admission, immediately before emulator spawn", async () => {
  const previous = process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
  try {
    process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = "true";
    const h = startupHarness(undefined, () => {
      expect(h.netsim.starts).toBe(1);
    });
    let admitted = false;
    let grant: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const launch = h.launcher.startEmulatorProcess("Pixel_9", {
      admitColdBoot: async () => {
        admitted = true;
        await ready;
        return { handOff: () => {}, release: () => {} };
      },
    });
    await drainUntil(() => admitted, { description: "boot admission request" });
    expect(h.netsim.starts).toBe(0);
    grant?.();
    await drainUntil(() => h.child.stdout.listenerCount("data") > 0, {
      description: "startup listeners",
    });
    h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
    await launch;
    h.child.emit("exit", 0, null);
    h.child.emit("close", 0, null);
    expect(h.netsim.stops).toBe(1);
    expectNoStartupTimers(h.timer);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION;
    } else {
      process.env.AUTOMOBILE_EMULATOR_NETSIM_ISOLATION = previous;
    }
  }
});

for (const marked of [true, false]) {
  test(`quickboot marker=${marked} controls launch args and is consumed only after readiness`, async () => {
    const markers = new FakeAvdColdBootMarkerStore();
    if (marked) {
      await markers.mark("Pixel_9");
    }
    let args: readonly string[] = [];
    const h = startupHarness(
      undefined,
      (spawnArgs) => {
        args = spawnArgs;
        expect(markers.marked.has("Pixel_9")).toBe(marked);
      },
      undefined,
      { avdColdBootMarkers: () => markers },
    );
    const { launch } = await launchStartup(h);
    expect(args.includes("-no-snapshot-load")).toBe(marked);
    h.child.emit("spawn");
    h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
    await launch;
    // Spawn and startup validation alone do not consume it; readiness does (#17929).
    expect(markers.marked.has("Pixel_9")).toBe(marked);
    expect(h.coldBootClears.isPending("Pixel_9")).toBe(marked);
    await h.coldBootClears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(false);
    expect(markers.calls.includes("remove:Pixel_9")).toBe(marked);
  });
}

test("quickboot marker survives a launch that exits before readiness", async () => {
  const markers = new FakeAvdColdBootMarkerStore();
  await markers.mark("Pixel_9");
  const h = startupHarness(undefined, undefined, undefined, { avdColdBootMarkers: () => markers });
  const { launch } = await launchStartup(h);
  h.child.emit("spawn");
  h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
  await launch;
  h.child.emit("exit", 1, null);
  await h.coldBootClears.clearAfterReady("Pixel_9");
  expect(markers.marked.has("Pixel_9")).toBe(true);
  expect(markers.calls).not.toContain("remove:Pixel_9");
});

for (const failure of ["throw", "error-event"] as const) {
  test(`failed spawn retains quickboot marker: ${failure}`, async () => {
    const markers = new FakeAvdColdBootMarkerStore();
    await markers.mark("Pixel_9");
    const h = startupHarness(
      undefined,
      () => {
        if (failure === "throw") {
          throw new Error("spawn refused");
        }
      },
      undefined,
      { avdColdBootMarkers: () => markers },
    );
    const launch = h.launcher.startEmulatorProcess("Pixel_9");
    if (failure === "error-event") {
      await drainUntil(() => h.child.listenerCount("error") > 0, { description: "error listener" });
      h.child.emit("error", new Error("spawn refused"));
    }
    await expect(launch).rejects.toThrow("spawn refused");
    expect(markers.marked.has("Pixel_9")).toBe(true);
    expect(markers.calls).not.toContain("remove:Pixel_9");
  });
}

for (const flag of [
  "-no-snapshot-load",
  "-no-snapshot",
  "-wipe-data",
  "-snapshot",
  "-snapshot=clean",
  "-snapshot-load",
]) {
  test(`quickboot marker respects existing snapshot argument ${flag}`, async () => {
    const markers = new FakeAvdColdBootMarkerStore();
    await markers.mark("Pixel_9");
    let args: readonly string[] = [];
    const h = startupHarness(
      undefined,
      (spawnArgs) => {
        args = spawnArgs;
      },
      undefined,
      { avdColdBootMarkers: () => markers },
    );
    const launch = h.launcher.startEmulatorProcess("Pixel_9", { requestedExtraArgs: [flag] });
    await drainUntil(() => h.child.stdout.listenerCount("data") > 0, {
      description: "startup listeners",
    });
    expect(args.filter((arg) => arg === "-no-snapshot-load")).toHaveLength(
      flag === "-no-snapshot-load" ? 1 : 0,
    );
    h.child.emit("spawn");
    h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
    await launch;
    await h.coldBootClears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(false);
  });
}

for (const failure of ["read", "remove"] as const) {
  test(`marker ${failure} failure does not fail emulator launch`, async () => {
    const markers = new FakeAvdColdBootMarkerStore();
    await markers.mark("Pixel_9");
    markers.failure = failure;
    const h = startupHarness(undefined, undefined, undefined, {
      avdColdBootMarkers: () => markers,
    });
    const { launch } = await launchStartup(h);
    h.child.emit("spawn");
    h.child.stdout.emit("data", Buffer.from("Detected GPU type"));
    expect((await launch).outcome).toBe("launched");
    await h.coldBootClears.clearAfterReady("Pixel_9");
    expect(markers.marked.has("Pixel_9")).toBe(true);
  });
}
