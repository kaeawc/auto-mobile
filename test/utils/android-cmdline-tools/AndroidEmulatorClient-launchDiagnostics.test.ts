import { EmulatorProcessOutputTail } from "../../../src/daemon/EmulatorProcessOutputTail";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import type { SpawnFn } from "../../../src/utils/HostCommandExecutor";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AndroidEmulatorClient,
  emulatorLaunchOutputSource,
  EmulatorExitedDuringReadinessError,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";

const avdName = "Pixel_9_Pro";

// Launch reservations are process-wide and outlive a test whose child never
// emits `exit`, and a live reservation is now evidence that this process is
// already launching that AVD (#6407). Reset between tests, as every other
// launch suite in this directory does.
afterEach(() => {
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
});

function execResult(stdout = "", stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}

async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the operation to reject, but it resolved");
}

class TestAdbClientFactory implements AdbClientFactory {
  constructor(private readonly executor: FakeAdbExecutor) {}

  create(_device?: BootedDevice | null): AdbExecutor {
    return this.executor;
  }
}

function createChild(): FakeChildProcess {
  return new FakeChildProcess();
}

type ProbeResult = (signal?: AbortSignal) => Promise<ExecResult>;

function createClient(
  child: FakeChildProcess,
  onSpawn: () => void,
  accelCheck: ProbeResult = async () => execResult(),
  timer = new FakeTimer(),
): {
  client: AndroidEmulatorClient;
  accelChecks: () => number;
  timer: FakeTimer;
  executor: FakeAdbExecutor;
} {
  const calls: string[][] = [];
  const executor = new FakeAdbExecutor();
  const factory = new TestAdbClientFactory(executor);
  const avdConfigReader = new FakeAvdConfigReader();
  const execAsync = async (
    _file: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<ExecResult> => {
    calls.push(args);
    if (args[0] === "-list-avds") {
      return execResult(`${avdName}\n`);
    }
    if (args[0] === "-accel-check") {
      return await accelCheck(signal);
    }
    return execResult();
  };
  const spawnFn: SpawnFn = () => {
    queueMicrotask(onSpawn);
    return child;
  };
  const client = new AndroidEmulatorClient({
    emulatorPathLocator: async () => "emulator",
    execAsync,
    spawnFn,
    timer,
    adbFactory: factory,
    avdConfigReader,
    platform: "linux",
  });

  return {
    client,
    executor,
    accelChecks: () => calls.filter((args) => args[0] === "-accel-check").length,
    timer,
  };
}

function emitFailure(
  child: FakeChildProcess,
  stderr: string,
  order: "stderr-before-exit" | "stderr-after-exit",
): void {
  if (order === "stderr-before-exit") {
    child.stderr.emit("data", Buffer.from(stderr));
  }
  child.emit("exit", 1, null);
  if (order === "stderr-after-exit") {
    child.stderr.emit("data", Buffer.from(stderr));
  }
  child.emit("close", 1, null);
}

describe("AndroidEmulatorClient launch diagnostics", () => {
  test("exposes redacted launch output after launch", async () => {
    const child = createChild();
    expect(emulatorLaunchOutputSource(child)).toBeUndefined();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", "Detected GPU type: host token=private\n");
    });
    expect(await client.startEmulator(avdName)).toBe(child);
    expect(emulatorLaunchOutputSource(child)?.snapshot()).toContain(
      "Detected GPU type: host token=[REDACTED]",
    );
    expect(emulatorLaunchOutputSource(child)?.snapshot()).not.toContain("private");
    child.stderr.emit("data", "later crashpad line\n");
    expect(emulatorLaunchOutputSource(child)?.snapshot()).toContain("later crashpad line");
    const tail = new EmulatorProcessOutputTail(child, timer);
    child.stdout.emit("data", "post-track line\n");
    child.emit("exit", null, "SIGSEGV");
    child.emit("close", null, "SIGSEGV");
    expect(await tail.finalize()).toBe(
      "Detected GPU type: host token=[REDACTED]\npost-track line\nlater crashpad line\n",
    );
    expect(emulatorLaunchOutputSource(child)?.flush()).toBe(tail.snapshot());
  });

  for (const path of ["monitor", "during-readiness", "before-readiness"] as const) {
    for (const exitCode of [0, 1, null]) {
      test(`readiness exit regression: ${path} code ${exitCode} rejects promptly`, async () => {
        const child = createChild();
        const { client, timer } = createClient(child, () => {
          child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
        });
        if (path !== "monitor") {
          await client.startEmulator(avdName);
        }
        const emitExit = () => {
          child.emit("exit", exitCode, exitCode === null ? "SIGTERM" : null);
          child.emit("close", exitCode, exitCode === null ? "SIGTERM" : null);
        };
        if (path === "before-readiness") {
          emitExit();
        }
        const controller = new AbortController();
        let rejection: unknown;
        const readiness = client
          .waitForEmulatorReady(avdName, 760_000, child, undefined, { signal: controller.signal })
          .then(
            () => {
              throw new Error("Expected readiness to reject");
            },
            (error: unknown) => {
              rejection = error;
            },
          );
        try {
          if (path !== "before-readiness") {
            emitExit();
          }
          await timer.advanceTimeAsync(0);
          await timer.advanceTimeAsync(1_000);
          // Immediate wake-up can remove every timer before advanceTimeAsync drains continuations.
          await drainUntil(() => rejection !== undefined, { description: "readiness exit" });
          expect(rejection).toBeInstanceOf(ActionableError);
          expect(rejection).toBeInstanceOf(EmulatorExitedDuringReadinessError);
          expect((rejection as { exitCode: number | null }).exitCode).toBe(exitCode);
          if (path === "monitor") {
            expect((rejection as Error).message).toBe(
              `Emulator process exited with code ${exitCode} while waiting for readiness`,
            );
          } else {
            expect((rejection as Error).message).toContain(`code: ${exitCode}`);
          }
          expect(rejection).not.toHaveProperty("code");
          expect(timer.now()).toBeLessThan(2_000);
        } finally {
          controller.abort(new Error("test cleanup"));
          await timer.advanceTimeAsync(1_000);
          await readiness;
        }
      });
    }
  }

  for (const [exitCode, signal] of [
    [1, null],
    [1, "SIGKILL"],
    [0, null],
    [null, "SIGKILL"],
  ] as const) {
    for (const order of ["stderr-before-exit", "stderr-after-exit"] as const) {
      test(`validated exit code ${exitCode}, signal ${signal}, ${order} preserves formatted diagnostics`, async () => {
        const child = createChild();
        let notifySpawn!: () => void;
        const spawned = new Promise<void>((resolve) => {
          notifySpawn = resolve;
        });
        const { client, timer } = createClient(child, notifySpawn);
        const startup = client.startEmulator(avdName);
        await spawned;
        await timer.advanceTimeAsync(5_000);
        await startup;
        const readiness = expectRejection(client.waitForEmulatorReady(avdName, 760_000, child));
        await timer.advanceTimeAsync(0);
        const diagnostic = "qemu: FATAL UNIQUE_DIAG_MARKER out of memory\n";
        if (order === "stderr-before-exit") {
          child.stderr.emit("data", Buffer.from(diagnostic));
        }
        child.emit("exit", exitCode, signal);
        if (order === "stderr-after-exit") {
          child.stderr.emit("data", Buffer.from(diagnostic));
        }
        child.stderr.emit("data", Buffer.from("token=diagnostic-secret\n"));
        child.emit("close", exitCode, signal);
        await timer.advanceTimeAsync(1_000);

        const error = await readiness;
        expect(error).toBeInstanceOf(EmulatorExitedDuringReadinessError);
        expect((error as EmulatorExitedDuringReadinessError).exitCode).toBe(exitCode);
        expect(error).not.toHaveProperty("code");
        expect(error.message).toContain(`code: ${exitCode}`);
        expect(error.message).toContain("UNIQUE_DIAG_MARKER");
        if (signal) {
          expect(error.message).toContain(signal);
        }
        expect(error.message).toBe(
          `Emulator process exited with code: ${exitCode}${signal ? ` (signal: ${signal})` : ""} (AVD '${avdName}')\n` +
            "Diagnostic:\n" +
            diagnostic +
            "token=[REDACTED]",
        );
      });
    }
  }

  for (const postValidation of [false, true]) {
    for (const exitCode of [0, 1, null]) {
      test(`readiness exit regression: duplicate AVD code ${exitCode}, validated=${postValidation} keeps polling`, async () => {
        const child = createChild();
        const { client, timer } = createClient(child, () => {
          child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
        });
        if (postValidation) {
          await client.startEmulator(avdName);
        }
        const controller = new AbortController();
        let settled = false;
        const readiness = client
          .waitForEmulatorReady(avdName, 760_000, child, undefined, { signal: controller.signal })
          .then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
        try {
          child.stderr.emit("data", Buffer.from("Running multiple emulators with the same AVD\n"));
          child.emit("exit", exitCode, exitCode === null ? "SIGTERM" : null);
          child.emit("close", exitCode, exitCode === null ? "SIGTERM" : null);
          await timer.advanceTimeAsync(1_000);
          expect(settled).toBe(false);
          expect(timer.getPendingTimeoutCount()).toBeGreaterThan(0);
        } finally {
          controller.abort(new Error("test cleanup"));
          await timer.advanceTimeAsync(1_000);
          await readiness;
        }
      });
    }
  }

  test("readiness exit regression: exit after completed readiness is a non-event", async () => {
    const child = createChild();
    const { client, timer, executor } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    await client.startEmulator(avdName);
    executor.setDevices([{ name: avdName, platform: "android", deviceId: "emulator-5554" }]);
    executor.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
    for (const [command, output] of [
      ["emu avd name", avdName],
      ["get-state", "device"],
      ["shell pm list packages", "package:android"],
      ["shell getprop sys.boot_completed", "1"],
      ["shell getprop init.svc.bootanim", "stopped"],
      ["shell getprop ro.product.model", "Pixel 9 Pro"],
    ]) {
      executor.setCommandResponse(command!, execResult(output));
    }
    const baselineListeners = child.listenerCount("exit");
    const readiness = client.waitForEmulatorReady(avdName, 760_000, child);
    await timer.advanceTimeAsync(1_000);
    const device = await readiness;
    expect(device.deviceId).toBe("emulator-5554");
    expect(child.listenerCount("exit")).toBe(baselineListeners);
    for (const exitCode of [0, 1, null]) {
      child.emit("exit", exitCode, exitCode === null ? "SIGTERM" : null);
      child.emit("close", exitCode, exitCode === null ? "SIGTERM" : null);
    }
    await timer.advanceTimeAsync(1_000);
    expect(await readiness).toBe(device);
  });

  test("preserves a missing shared-library error emitted after exit and before close", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      emitFailure(
        child,
        "emulator: error while loading shared libraries: libxkbfile.so.1: cannot open shared object file\n",
        "stderr-after-exit",
      );
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("libxkbfile.so.1");
    expect(error.message).toContain("category=missing_shared_library");
    expect(error.message).toContain(`AVD '${avdName}'`);
    expect(error.message).toContain("exited with code: 1");
    expect(accelChecks()).toBe(0);
  });

  test("classifies missing shared-library output that arrives before exit", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      emitFailure(
        child,
        "emulator: error while loading shared libraries: libxkbfile.so.1: cannot open shared object file\n",
        "stderr-before-exit",
      );
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("libxkbfile.so.1");
    expect(error.message).toContain("category=missing_shared_library");
  });

  test("preserves a split failure signature while redacting a multiline credential", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stderr.emit(
        "data",
        Buffer.from('token="redaction-canary\nsecret-tail"\nemulator: error while loading shared '),
      );
      child.stderr.emit(
        "data",
        Buffer.from("libraries: libxkbfile.so.1: cannot open shared object file\n"),
      );
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("category=missing_shared_library");
    expect(error.message).toContain("libxkbfile.so.1");
    expect(error.message).toContain("token=[REDACTED]");
    expect(error.message).not.toContain("redaction-canary");
    expect(error.message).not.toContain("secret-tail");
  });

  test("does not combine credential state between stdout and stderr", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stderr.emit("data", Buffer.from("token="));
      child.stdout.emit("data", Buffer.from("diagnostic output\n"));
      child.stderr.emit(
        "data",
        Buffer.from(
          "actual-secret\nemulator: error while loading shared libraries: libxkbfile.so.1\n",
        ),
      );
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("category=missing_shared_library");
    expect(error.message).toContain("token=[REDACTED]");
    expect(error.message).toContain("diagnostic output");
    expect(error.message).not.toContain("actual-secret");
  });

  test("preserves rejected acceleration-check output for KVM permission denial", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(
      child,
      () =>
        emitFailure(
          child,
          "ProbeKVM: Could not open /dev/kvm: Permission denied\n",
          "stderr-before-exit",
        ),
      async () => {
        throw Object.assign(new Error("emulator -accel-check failed"), {
          stdout: "",
          stderr: "This user does not have permissions to use KVM.\n",
        });
      },
    );

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("category=kvm_permission_denied");
    expect(error.message).toContain("This user does not have permissions to use KVM.");
    expect(error.message).toContain(`AVD '${avdName}'`);
    expect(error.message).toContain("exited with code: 1");
    expect(accelChecks()).toBe(1);
  });

  test("uses successful acceleration-check output to classify unavailable acceleration", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(
      child,
      () => emitFailure(child, "emulator initialization failed\n", "stderr-before-exit"),
      async () => execResult("acceleration is not available on this host\n"),
    );

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("category=hardware_acceleration_unavailable");
    expect(error.message).toContain("acceleration is not available on this host");
    expect(accelChecks()).toBe(1);
  });

  test("keeps duplicate-AVD detection after later output overflows the diagnostic tail", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      child.stderr.emit(
        "data",
        Buffer.from(
          [
            "Running multiple emulators with the same AVD is an experimental feature.",
            ...Array.from({ length: 60 }, (_, index) => `later line ${index}`),
          ].join("\n"),
        ),
      );
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    });

    const launch = await client.launchEmulator({ avdName });
    expect(launch.process).toBeNull();
    expect(launch.outcome).toBe("duplicate-of-external");
    expect(accelChecks()).toBe(0);
  });

  test("keeps corrupt-image detection when a noisy chunk exceeds the diagnostic tail", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stderr.emit(
        "data",
        Buffer.from(
          [
            "qcow2: Image is corrupt; cannot be opened read/write",
            ...Array.from({ length: 60 }, (_, index) => `later line ${index}`),
          ].join("\n"),
        ),
      );
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("Disk image is corrupt");
  });

  test("keeps a validated launch resolved after a later clean exit", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });

    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);

    expect(launchedChild).toBe(child);
    expect(accelChecks()).toBe(0);
  });

  test("detaches startup classification after the success marker but keeps output capture", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });

    const launchedChild = await client.startEmulator(avdName);
    expect(launchedChild).toBe(child);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);

    child.stderr.emit("data", Buffer.from("PANIC: QEMU later runtime diagnostic\n"));
    child.stderr.emit("data", Buffer.from("qcow2: Image is corrupt; later runtime text\n"));

    expect(child.killed).toBe(false);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
  });

  test("detaches startup classification after the assume-success timeout", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {});
    const launch = client.startEmulator(avdName);
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(5_000);
    const launchedChild = await launch;

    expect(launchedChild).toBe(child);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    child.stderr.emit("data", Buffer.from("PANIC: QEMU later runtime diagnostic\n"));
    child.stderr.emit("data", Buffer.from("qcow2: Image is corrupt; later runtime text\n"));
    expect(child.killed).toBe(false);
  });

  test("replays a post-validation exit to readiness with launch diagnostics", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const baselineExitListeners = child.listenerCount("exit");
    child.stderr.emit("data", Buffer.from("token=handoff-secret\nhandoff diagnostic\n"));
    child.emit("exit", 1, null);

    const readiness = expectRejection(client.waitForEmulatorReady(avdName, 60_000, launchedChild));

    child.stderr.emit(
      "data",
      Buffer.from(
        "late handoff diagnostic\nqemu_mprotect__osdep: mprotect failed: Permission denied\n",
      ),
    );
    child.emit("close", 1, null);
    const error = await readiness;

    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("handoff diagnostic");
    expect(error.message).toContain("late handoff diagnostic");
    expect(error.message).toContain("qemu_mprotect__osdep");
    expect(error.message).toContain("token=[REDACTED]");
    expect(error.message).not.toContain("handoff-secret");
    expect(timer.getSleepCallCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(baselineExitListeners);
  });

  test("preserves richer diagnostics emitted after a post-validation exit", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 1, null);
    const readiness = expectRejection(client.waitForEmulatorReady(avdName, 60_000, launchedChild));
    child.stderr.emit(
      "data",
      Buffer.from("qemu_mprotect__osdep: mprotect failed: Permission denied\n"),
    );
    child.emit("close", 1, null);

    const error = await readiness;
    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("qemu_mprotect__osdep");
  });

  test("keeps a post-validation duplicate-AVD exit nonfatal", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    child.stderr.emit(
      "data",
      Buffer.from("Running multiple emulators with the same AVD is an experimental feature.\n"),
    );
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    const controller = new AbortController();
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild, undefined, {
      signal: controller.signal,
    });
    let rejection: Error | undefined;
    void readiness.catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejection).toBeUndefined();
      expect(accelChecks()).toBe(0);
    } finally {
      controller.abort(new Error("test cleanup"));
      await readiness.catch(() => undefined);
    }
  });

  test("bounds post-validation exit diagnostic draining", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 1, null);
    const readiness = expectRejection(client.waitForEmulatorReady(avdName, 60_000, launchedChild));
    let settled = false;
    void readiness.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    await timer.advanceTimeAsync(999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await timer.advanceTimeAsync(1);
    const error = await readiness;
    expect(error.message).toContain("exited with code: 1");
  });

  test("installs readiness exit monitoring without a check-to-listener yield", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const baselineExitListeners = child.listenerCount("exit");
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild);
    const readinessSettled = readiness.catch(() => undefined);

    try {
      expect(child.listenerCount("exit")).toBe(baselineExitListeners + 1);
    } finally {
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      await timer.advanceTimeAsync(500);
      await readinessSettled;
    }
  });

  test("keeps post-validation exit finalization bounded after a child error", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 1, null);
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild);
    let rejection: Error | undefined;
    void readiness.catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });
    child.emit("error", new Error("stdio failed after exit"));

    try {
      await timer.advanceTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejection?.message).toContain("exited with code: 1");
    } finally {
      child.emit("close", 1, null);
      await readiness.catch(() => undefined);
    }
  });

  test("preserves diagnostics emitted after a post-exit child error", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 1, null);
    const readiness = expectRejection(client.waitForEmulatorReady(avdName, 60_000, launchedChild));
    child.emit("error", new Error("stdio failed after exit"));
    child.stderr.emit(
      "data",
      Buffer.from("qemu_mprotect__osdep: mprotect failed: Permission denied\n"),
    );
    child.emit("close", 1, null);

    const error = await readiness;
    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("qemu_mprotect__osdep");
  });

  test("prefers finalized diagnostics for exits observed during readiness", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const readiness = expectRejection(client.waitForEmulatorReady(avdName, 60_000, launchedChild));

    for (let turn = 0; turn < 10 && timer.getPendingTimeoutCount() < 2; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    child.emit("exit", 1, null);
    child.stderr.emit(
      "data",
      Buffer.from("qemu_mprotect__osdep: mprotect failed: Permission denied\n"),
    );
    child.emit("close", 1, null);
    await timer.advanceTimeAsync(500);

    const error = await readiness;
    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("qemu_mprotect__osdep");
  });

  test("does not classify post-validation duplicate-looking output as startup adoption", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const controller = new AbortController();
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild, undefined, {
      signal: controller.signal,
    });
    let rejection: Error | undefined;
    void readiness.catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    try {
      for (let turn = 0; turn < 10 && timer.getPendingTimeoutCount() < 2; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      child.stderr.emit(
        "data",
        Buffer.from("Running multiple emulators with the same AVD is an experimental feature.\n"),
      );
      for (let index = 0; index < 51; index += 1) {
        child.stderr.emit("data", Buffer.from(`later readiness diagnostic ${index}\n`));
      }
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      await timer.advanceTimeAsync(500);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(rejection?.message).toContain("exited with code: 1");
    } finally {
      controller.abort(new Error("test cleanup"));
      await readiness.catch(() => undefined);
    }
  });

  test("removes readiness listeners after observing a process exit", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const baselineExitListeners = child.listenerCount("exit");
    const baselineStdoutListeners = child.stdout.listenerCount("data");
    const baselineStderrListeners = child.stderr.listenerCount("data");
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild);
    const readinessError = expectRejection(readiness);

    for (let turn = 0; turn < 10 && timer.getPendingTimeoutCount() < 2; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    await timer.advanceTimeAsync(500);

    const error = await readinessError;
    expect(error.message).toContain("exited with code: 1");
    expect(child.listenerCount("exit")).toBe(baselineExitListeners);
    expect(child.stdout.listenerCount("data")).toBe(baselineStdoutListeners);
    expect(child.stderr.listenerCount("data")).toBe(baselineStderrListeners);
  });

  test("times out an acceleration check without masking the original exit code", async () => {
    const child = createChild();
    let probeSignal: AbortSignal | undefined;
    const { client, timer } = createClient(
      child,
      () => emitFailure(child, "emulator initialization failed\n", "stderr-before-exit"),
      (signal) => {
        probeSignal = signal;
        return new Promise<ExecResult>(() => {});
      },
    );

    const start = client.startEmulator(avdName);
    while (!probeSignal) {
      await Promise.resolve();
    }
    timer.advanceTime(3_000);

    const error = await expectRejection(start);

    expect(probeSignal.aborted).toBe(true);
    expect(error.message).toContain("exited with code: 1");
  });

  test("bounds the wait for close after a nonzero exit", async () => {
    const child = createChild();
    let exited = false;
    const { client, timer } = createClient(child, () => {
      child.emit("exit", 1, null);
      exited = true;
    });

    const start = client.startEmulator(avdName);
    while (!exited) {
      await Promise.resolve();
    }
    timer.advanceTime(1_000);

    const error = await expectRejection(start);

    expect(error.message).toContain("exited with code: 1");
  });

  test("rejects promptly when the child exits cleanly before startup validation", async () => {
    const child = createChild();
    const { client, accelChecks, timer } = createClient(child, () => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    let rejection: Error | undefined;
    void client.startEmulator(avdName).catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    for (let turn = 0; turn < 10 && !rejection; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(rejection?.message).toContain("exited with code: 0");
    expect(rejection?.message).toContain(`AVD '${avdName}'`);
    expect(accelChecks()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rejects when a startup marker drains after child exit", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      child.emit("exit", 0, null);
      child.stdout.emit("data", Buffer.from("Detected GPU type: host\n"));
      child.emit("close", 0, null);
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("exited with code: 0");
    expect(error.message).toContain(`AVD '${avdName}'`);
    expect(accelChecks()).toBe(0);
  });

  test("bounds and redacts a generic early-exit diagnostic tail", async () => {
    const child = createChild();
    const home = homedir();
    const lines = Array.from({ length: 55 }, (_, index) => `line-${index}`);
    lines.push(`token=super-secret ${home}/.android/avd/Pixel_9_Pro.avd`);
    const { client } = createClient(
      child,
      () => emitFailure(child, `${lines.join("\n")}\n`, "stderr-after-exit"),
      async () => execResult("acceleration is not available\n"),
    );

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).not.toContain("line-0");
    expect(error.message).toContain("line-54");
    expect(error.message).not.toContain("super-secret");
    expect(error.message).toContain("token=[REDACTED]");
    expect(error.message).not.toContain(home);
  });

  test("keeps the existing display remediation while adding its category", async () => {
    const child = createChild();
    const { client, accelChecks } = createClient(child, () => {
      emitFailure(
        child,
        'Warning: could not connect to display (:0)\nCould not load the Qt platform plugin "xcb"\n',
        "stderr-before-exit",
      );
    });

    const error = await expectRejection(client.startEmulator(avdName));

    expect(error.message).toContain("AUTOMOBILE_EMULATOR_HEADLESS");
    expect(error.message).toContain("category=display_initialization_failed");
    expect(accelChecks()).toBe(0);
  });
});

const startupFixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/android-emulator/${name}.txt`, import.meta.url), "utf8");
const benignStartupLine = startupFixture("normal-startup").split("\n")[0] + "\n";

async function pendingStartup(signal?: AbortSignal) {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  let spawned = false;
  const harness = createClient(
    child,
    () => {
      spawned = true;
    },
    undefined,
    timer,
  );
  let settled = false;
  const launch = harness.client
    .launchEmulator({ avdName, signal })
    .then((handle) => handle.process)
    .then(
      (process) => {
        settled = true;
        return process;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
  // Attach a handler before emitting failure output, so rejections are always observed.
  const rejection = expectRejection(launch);
  void rejection.catch(() => {});
  await drainUntil(() => spawned, { description: "emulator startup" });
  return { ...harness, child, launch, rejection, settled: () => settled };
}

async function immediateFailureMessage(output: string) {
  const harness = await pendingStartup();
  harness.child.stderr.emit("data", output);
  const error = await harness.rejection;
  await harness.timer.advanceTimeAsync(0);
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
  return error.message;
}

function expectStartupTimersCleared(timer: FakeTimer) {
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(timer.getPendingIntervalCount()).toBe(0);
}

describe("early startup validation diagnostic parity", () => {
  for (const fixture of ["arch-panic", "sandbox-mprotect", "corrupt-qcow2", "display-xcb"]) {
    test(`${fixture} during stdout grace rejects with the original actionable diagnostic`, async () => {
      const output = startupFixture(fixture);
      const originalMessage = await immediateFailureMessage(output);
      const harness = await pendingStartup();
      harness.child.stdout.emit("data", benignStartupLine);
      await harness.timer.advanceTimeAsync(500);
      harness.child.stderr.emit("data", output);
      const error = await harness.rejection;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error.message).toBe(originalMessage);
      await harness.timer.advanceTimeAsync(0);
      expectStartupTimersCleared(harness.timer);
      await harness.timer.advanceTimeAsync(5000);
      expect(await harness.rejection).toBe(error);
    });
  }

  test("classifies PANIC in the first stdout chunk before arming grace", async () => {
    const harness = await pendingStartup();
    harness.child.stdout.emit("data", benignStartupLine + startupFixture("arch-panic"));
    const error = await harness.rejection;
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.message).toContain("AVD architecture 'x86_64' is not supported");
    await harness.timer.advanceTimeAsync(0);
    expectStartupTimersCleared(harness.timer);
    await harness.timer.advanceTimeAsync(5000);
    expect(await harness.rejection).toBe(error);
  });

  test("child exit during grace keeps early-exit diagnostics while waiting for close", async () => {
    const harness = await pendingStartup();
    harness.child.stdout.emit("data", benignStartupLine);
    await harness.timer.advanceTimeAsync(500);
    harness.child.emit("exit", 1, null);
    expect(harness.timer.getPendingTimeouts()).toEqual([1000]);
    expect(harness.timer.getPendingIntervals()).toEqual([]);
    // The grace deadline must not resolve while the early-exit drain is pending.
    await harness.timer.advanceTimeAsync(500);
    expect(harness.settled()).toBe(false);
    harness.child.emit("close", 1, null);
    const error = await harness.rejection;
    expect(error.message).toContain("Emulator process exited with code: 1");
    expect(error.message).toContain(benignStartupLine.trim());
    expectStartupTimersCleared(harness.timer);
    await harness.timer.advanceTimeAsync(5000);
    expect(await harness.rejection).toBe(error);
  });
});

describe("client early-serial probe wiring", () => {
  test("bypasses the inventory cache and passes the request signal on each poll", async () => {
    const controller = new AbortController();
    const harness = await pendingStartup(controller.signal);
    const calls: unknown[][] = [];
    harness.client.getBootedDevicesChecked = async (onlyEmulators, options, signal) => {
      calls.push([onlyEmulators, options, signal]);
      return [
        {
          name: avdName,
          platform: "android",
          deviceId: calls.length === 2 ? "emulator-5554" : "emulator-5556",
        },
      ];
    };
    await harness.timer.advanceTimeAsync(500);
    expect(harness.settled()).toBe(false);
    await harness.timer.advanceTimeAsync(500);
    expect(harness.settled()).toBe(true);
    expect(await harness.launch).toBe(harness.child);
    expect(calls).toEqual([
      [
        true,
        { bypassDeviceListCache: true, skipNameEnrichment: true, skipProfileEnrichment: true },
        controller.signal,
      ],
      [
        true,
        { bypassDeviceListCache: true, skipNameEnrichment: true, skipProfileEnrichment: true },
        controller.signal,
      ],
    ]);
    expectStartupTimersCleared(harness.timer);
  });

  test("an unavailable adb probe falls back to stdout grace", async () => {
    const harness = await pendingStartup();
    let probes = 0;
    harness.client.getBootedDevicesChecked = async () => {
      probes++;
      throw new Error("adb unavailable");
    };
    harness.child.stdout.emit("data", benignStartupLine);
    await harness.timer.advanceTimeAsync(999);
    expect(harness.settled()).toBe(false);
    expect(probes).toBe(1);
    await harness.timer.advanceTimeAsync(1);
    expect(await harness.launch).toBe(harness.child);
    expectStartupTimersCleared(harness.timer);
  });

  test("a pending successful probe cannot override a classified rejection", async () => {
    const harness = await pendingStartup();
    let finishProbe!: (devices: BootedDevice[]) => void;
    harness.client.getBootedDevicesChecked = () =>
      new Promise((resolve) => {
        finishProbe = resolve;
      });
    harness.child.stdout.emit("data", benignStartupLine);
    await harness.timer.advanceTimeAsync(500);
    harness.child.stderr.emit("data", startupFixture("arch-panic"));
    const error = await harness.rejection;
    finishProbe([{ name: avdName, platform: "android", deviceId: "emulator-5554" }]);
    await harness.timer.advanceTimeAsync(5000);
    expect(await harness.rejection).toBe(error);
    expectStartupTimersCleared(harness.timer);
  });
});
