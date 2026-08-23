import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type {
  AdbDeviceState,
  AdbExecutor,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const result = (stdout = "", stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

class ReadinessAdbExecutor extends FakeAdbExecutor {
  discoveryAttempts = 0;
  discoverySignal: AbortSignal | undefined;
  discoveryErrors: Error[] = [];
  blockDiscovery = false;
  releaseDiscovery: (() => void) | undefined;
  blockReadinessProbes = false;
  readinessProbeCalls = 0;

  override async getBootedAndroidDevices(options?: {
    bypassCache?: boolean;
    throwOnMissingAdb?: boolean;
    signal?: AbortSignal;
  }): Promise<BootedDevice[]> {
    this.discoveryAttempts += 1;
    this.discoverySignal = options?.signal;
    const error = this.discoveryErrors.shift();
    if (error) {
      throw error;
    }
    if (this.blockDiscovery) {
      await new Promise<void>((resolve, reject) => {
        this.releaseDiscovery = resolve;
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new Error("discovery cancelled")),
          { once: true },
        );
      });
    }
    return super.getBootedAndroidDevices();
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const readinessCommands = new Set([
      "get-state",
      "shell pm list packages",
      "shell getprop sys.boot_completed",
      "shell getprop init.svc.bootanim",
    ]);
    if (this.blockReadinessProbes && readinessCommands.has(command)) {
      this.readinessProbeCalls += 1;
      return await new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("readiness probe cancelled")),
          { once: true },
        );
      });
    }
    return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }
}

class ReadinessAdbFactory implements AdbClientFactory {
  constructor(private readonly adb: AdbExecutor) {}

  create(): AdbExecutor {
    return this.adb;
  }
}

function clientWith(adb: ReadinessAdbExecutor, timer: FakeTimer): AndroidEmulatorClient {
  return new AndroidEmulatorClient(async () => result(), null, timer, new ReadinessAdbFactory(adb));
}

function configureReadyDevice(adb: ReadinessAdbExecutor): void {
  adb.setDevices([
    {
      name: "Pixel_9_Pro",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    },
  ]);
  adb.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
  adb.setCommandResponse("emu avd name", result("Pixel_9_Pro\n"));
  adb.setCommandResponse("get-state", result("device\n"));
  adb.setCommandResponse("shell pm list packages", result("package:android\n"));
  adb.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
  adb.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
}

describe("Android emulator readiness diagnostics", () => {
  test("reports a persistent, sanitized device-discovery failure", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new ReadinessAdbExecutor();
    const longDetail = "x".repeat(2_000);
    adb.discoveryErrors = [
      new Error(`adb server unavailable token=super-secret ${longDetail}`),
      new Error(`adb server unavailable token=super-secret ${longDetail}`),
    ];

    const readiness = clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 100);

    await expect(readiness).rejects.toThrow("phase=device-discovery");
    await expect(readiness).rejects.toThrow("token=[REDACTED]");
    await expect(readiness).rejects.not.toThrow("super-secret");
    const error = await readiness.catch((cause: unknown) => cause as Error);
    expect(error.message.length).toBeLessThan(1_000);
  });

  test("reports persistent AVD-name resolution failure without discarding the target", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new ReadinessAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
        source: "local",
      },
    ]);
    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
    adb.setCommandError("emu avd name", new Error("emulator console unavailable"));
    adb.setCommandError(
      "shell getprop ro.boot.qemu.avd_name",
      new Error("AVD property unavailable"),
    );

    await expect(
      clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"),
    ).rejects.toThrow("phase=avd-name-resolution");
  });

  test("retries a transient discovery failure within the readiness budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new ReadinessAdbExecutor();
    configureReadyDevice(adb);
    adb.discoveryErrors = [new Error("temporary adb server failure")];

    const device = await clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      null,
      "emulator-5554",
    );

    expect(device.deviceId).toBe("emulator-5554");
    expect(adb.discoveryAttempts).toBeGreaterThan(1);
  });

  test("cancels discovery already in flight", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new ReadinessAdbExecutor();
    adb.blockDiscovery = true;
    const controller = new AbortController();
    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      null,
      "emulator-5554",
      controller.signal,
    );

    while (!adb.releaseDiscovery) {
      await Promise.resolve();
    }
    controller.abort(new Error("caller cancelled readiness"));
    adb.releaseDiscovery();

    expect(adb.discoverySignal).toBe(controller.signal);
    await expect(readiness).rejects.toThrow("caller cancelled readiness");
  });

  test("stops an absent-target poll when cancelled between iterations", async () => {
    const timer = new FakeTimer();
    const adb = new ReadinessAdbExecutor();
    const controller = new AbortController();
    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      null,
      "emulator-5554",
      controller.signal,
    );
    let rejection: Error | undefined;
    const observedReadiness = readiness.catch((error: unknown) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    for (let turn = 0; turn < 10 && timer.getPendingTimeoutCount() < 2; turn += 1) {
      await Promise.resolve();
    }
    const waitingBetweenIterations = timer.getPendingTimeoutCount() === 2;
    controller.abort(new Error("caller cancelled absent-target poll"));
    for (let turn = 0; turn < 10 && !rejection; turn += 1) {
      await Promise.resolve();
    }
    const settledWithoutTimerAdvance = rejection !== undefined;
    if (!settledWithoutTimerAdvance) {
      timer.resolveAll();
      timer.advanceTime(5_000);
      await observedReadiness;
    }

    expect(waitingBetweenIterations).toBe(true);
    expect(settledWithoutTimerAdvance).toBe(true);
    expect(rejection?.message).toContain("caller cancelled absent-target poll");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancels parallel readiness probes without waiting for another timer tick", async () => {
    const timer = new FakeTimer();
    const adb = new ReadinessAdbExecutor();
    configureReadyDevice(adb);
    adb.blockReadinessProbes = true;
    const controller = new AbortController();
    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      null,
      "emulator-5554",
      controller.signal,
    );
    let rejection: Error | undefined;
    void readiness.catch((error: unknown) => {
      rejection = error instanceof Error ? error : new Error(String(error));
    });

    while (adb.readinessProbeCalls < 4) {
      await Promise.resolve();
    }
    controller.abort(new Error("caller cancelled parallel probes"));
    for (let turn = 0; turn < 10 && !rejection; turn += 1) {
      await Promise.resolve();
    }
    const settledWithoutTimerAdvance = rejection !== undefined;
    if (!settledWithoutTimerAdvance) {
      timer.advanceTime(5_000);
      await readiness.catch(() => undefined);
    }

    expect(settledWithoutTimerAdvance).toBe(true);
    expect(rejection?.message).toContain("caller cancelled parallel probes");
  });

  for (const row of [
    {
      name: "absent",
      states: [] as AdbDeviceState[],
      devices: [] as BootedDevice[],
    },
    {
      name: "offline",
      states: [{ deviceId: "emulator-5554", state: "offline" }],
      devices: [] as BootedDevice[],
    },
    {
      name: "not-ready",
      states: [{ deviceId: "emulator-5554", state: "device" }],
      devices: [
        {
          name: "Pixel_9_Pro",
          platform: "android" as const,
          deviceId: "emulator-5554",
          source: "local" as const,
        },
      ],
    },
  ]) {
    test(`reports a known serial as ${row.name}`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new ReadinessAdbExecutor();
      adb.setDeviceStates(row.states);
      adb.setDevices(row.devices);
      adb.setCommandResponse("emu avd name", result("Pixel_9_Pro\n"));

      await expect(
        clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"),
      ).rejects.toThrow(`target=emulator-5554; state=${row.name}`);
    });
  }
});
