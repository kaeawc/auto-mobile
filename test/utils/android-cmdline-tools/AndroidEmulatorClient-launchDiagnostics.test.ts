import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const avdName = "Pixel_9_Pro";

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

function createChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new Readable({ read() {} }) as never;
  child.stderr = new Readable({ read() {} }) as never;
  child.killed = false;
  child.pid = 1234;
  child.kill = (() => {
    child.killed = true;
    return true;
  }) as ChildProcess["kill"];
  return child;
}

type ProbeResult = (signal?: AbortSignal) => Promise<ExecResult>;

function createClient(
  child: ChildProcess & EventEmitter,
  onSpawn: () => void,
  accelCheck: ProbeResult = async () => execResult(),
): { client: AndroidEmulatorClient; accelChecks: () => number; timer: FakeTimer } {
  const timer = new FakeTimer();
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
  const spawnFn = (() => {
    queueMicrotask(onSpawn);
    return child;
  }) as never;
  const client = new AndroidEmulatorClient(
    execAsync,
    spawnFn,
    timer,
    factory,
    avdConfigReader,
    "linux",
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";

  return {
    client,
    accelChecks: () => calls.filter((args) => args[0] === "-accel-check").length,
    timer,
  };
}

function emitFailure(
  child: ChildProcess & EventEmitter,
  stderr: string,
  order: "stderr-before-exit" | "stderr-after-exit",
): void {
  if (order === "stderr-before-exit") {
    child.stderr!.emit("data", Buffer.from(stderr));
  }
  child.emit("exit", 1, null);
  if (order === "stderr-after-exit") {
    child.stderr!.emit("data", Buffer.from(stderr));
  }
  child.emit("close", 1, null);
}

describe("AndroidEmulatorClient launch diagnostics", () => {
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
      child.stderr!.emit(
        "data",
        Buffer.from('token="redaction-canary\nsecret-tail"\nemulator: error while loading shared '),
      );
      child.stderr!.emit(
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
      child.stderr!.emit("data", Buffer.from("token="));
      child.stdout!.emit("data", Buffer.from("diagnostic output\n"));
      child.stderr!.emit(
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
      child.stderr!.emit(
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

    await expect(client.startEmulator(avdName)).resolves.toBeNull();
    expect(accelChecks()).toBe(0);
  });

  test("keeps corrupt-image detection when a noisy chunk exceeds the diagnostic tail", async () => {
    const child = createChild();
    const { client } = createClient(child, () => {
      child.stderr!.emit(
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
      child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
    });

    const launchedChild = await client.startEmulator(avdName);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);

    expect(launchedChild).toBe(child);
    expect(accelChecks()).toBe(0);
  });

  test("replays a post-validation exit to readiness with launch diagnostics", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const baselineExitListeners = child.listenerCount("exit");
    child.stderr!.emit(
      "data",
      Buffer.from("token=handoff-secret\nhandoff diagnostic\n"),
    );
    child.emit("exit", 1, null);

    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild);
    let rejection: Error | undefined;
    void readiness.catch((error) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    try {
      for (let turn = 0; turn < 10 && !rejection; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(rejection?.message).toContain("exited with code: 1");
      expect(rejection?.message).toContain("handoff diagnostic");
      expect(rejection?.message).toContain("token=[REDACTED]");
      expect(rejection?.message).not.toContain("handoff-secret");
      expect(timer.getSleepCallCount()).toBe(0);
      expect(child.listenerCount("exit")).toBe(baselineExitListeners);
    } finally {
      child.emit("close", 1, null);
      timer.setCurrentTime(60_000);
      timer.resolveAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      timer.resolveAll();
      await readiness.catch(() => undefined);
    }
  });

  test("removes readiness listeners after observing a process exit", async () => {
    const child = createChild();
    const { client, timer } = createClient(child, () => {
      child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
    });
    const launchedChild = await client.startEmulator(avdName);
    const baselineExitListeners = child.listenerCount("exit");
    const baselineStdoutListeners = child.stdout!.listenerCount("data");
    const baselineStderrListeners = child.stderr!.listenerCount("data");
    const readiness = client.waitForEmulatorReady(avdName, 60_000, launchedChild);
    const readinessError = expectRejection(readiness);

    for (let turn = 0; turn < 10 && timer.getSleepCallCount() < 2; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    await timer.advanceTimeAsync(500);

    const error = await readinessError;
    expect(error.message).toContain("exited with code 1");
    expect(child.listenerCount("exit")).toBe(baselineExitListeners);
    expect(child.stdout!.listenerCount("data")).toBe(baselineStdoutListeners);
    expect(child.stderr!.listenerCount("data")).toBe(baselineStderrListeners);
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
      child.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
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
