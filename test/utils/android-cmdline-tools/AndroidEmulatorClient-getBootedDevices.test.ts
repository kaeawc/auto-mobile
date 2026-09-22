import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeEmulatorConsoleBusyRegistry } from "../../fakes/FakeEmulatorConsoleBusyRegistry";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { DiscoveryObservationSequence } from "../../../src/utils/DiscoveryObservationSequence";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

function execResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class FailingDiscoveryAdbExecutor extends FakeAdbExecutor {
  override async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    throw new Error("adb server unavailable");
  }
}

class RecordingAdbExecutor extends FakeAdbExecutor {
  lastDiscoveryOptions: { bypassCache?: boolean; throwOnMissingAdb?: boolean } | undefined;
  lastExecuteOptions: AdbExecuteOptions | undefined;

  override async execute(args: string[], options: AdbExecuteOptions = {}) {
    this.lastExecuteOptions = options;
    return await super.execute(args, options);
  }

  override async getBootedAndroidDevices(options?: {
    bypassCache?: boolean;
    throwOnMissingAdb?: boolean;
  }): Promise<BootedDevice[]> {
    this.lastDiscoveryOptions = options;
    return super.getBootedAndroidDevices();
  }
}

class DeferredAvdNameAdbExecutor extends FakeAdbExecutor {
  private readonly avdNameProbe: Promise<ExecResult>;
  private rejectAvdNameProbePromise: (reason?: unknown) => void = () => {};
  private signalAvdNameProbeStarted: () => void = () => {};
  readonly avdNameProbeStarted: Promise<void>;

  constructor() {
    super();
    this.avdNameProbe = new Promise<ExecResult>((_resolve, reject) => {
      this.rejectAvdNameProbePromise = reject;
    });
    this.avdNameProbeStarted = new Promise<void>((resolve) => {
      this.signalAvdNameProbeStarted = resolve;
    });
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (command === "emu avd name") {
      this.signalAvdNameProbeStarted();
      return await this.avdNameProbe;
    }
    return await super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }

  rejectAvdNameProbe(error: Error): void {
    this.rejectAvdNameProbePromise(error);
  }
}

class SequencedDeferredAvdNameAdbExecutor extends FakeAdbExecutor {
  private readonly avdNameProbe = Promise.withResolvers<ReturnType<typeof execResult>>();
  readonly avdNameProbeStarted = Promise.withResolvers<void>();

  constructor(private readonly observationSequence: DiscoveryObservationSequence) {
    super();
  }

  override async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    return [
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
        observedAt: this.observationSequence.next(),
      },
    ];
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ) {
    if (command === "emu avd name") {
      this.avdNameProbeStarted.resolve();
      return await this.avdNameProbe.promise;
    }
    return await super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }

  resolveAvdName(name: string): void {
    this.avdNameProbe.resolve(execResult(`${name}\n`));
  }
}

interface AvdProbeConcurrency {
  active: number;
  maximum: number;
}

class DelayedAvdNameAdbExecutor extends FakeAdbExecutor {
  constructor(
    private readonly timer: FakeTimer,
    private readonly avdName: string,
    private readonly delayMs: number,
    private readonly concurrency: AvdProbeConcurrency,
    private readonly fail: boolean,
  ) {
    super();
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (command !== "emu avd name") {
      return await super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
    }

    this.concurrency.active++;
    this.concurrency.maximum = Math.max(this.concurrency.maximum, this.concurrency.active);
    try {
      await this.timer.sleep(this.delayMs);
      if (this.fail) {
        throw new Error(`AVD-name probe failed for ${this.avdName}`);
      }
      return execResult(`${this.avdName}\n`);
    } finally {
      this.concurrency.active--;
    }
  }
}

class DelayedAvdNameAdbFactory implements AdbClientFactory {
  private readonly discovery = new FakeAdbExecutor();
  private readonly clients = new Map<string, DelayedAvdNameAdbExecutor>();

  constructor(
    devices: BootedDevice[],
    timer: FakeTimer,
    delaysByDevice: ReadonlyMap<string, number>,
    concurrency: AvdProbeConcurrency,
    failedDeviceId?: string,
  ) {
    this.discovery.setDevices(devices);
    for (const device of devices) {
      this.clients.set(
        device.deviceId,
        new DelayedAvdNameAdbExecutor(
          timer,
          `AVD_${device.deviceId}`,
          delaysByDevice.get(device.deviceId) ?? 0,
          concurrency,
          device.deviceId === failedDeviceId,
        ),
      );
    }
  }

  create(device?: BootedDevice | null) {
    return device ? this.clients.get(device.deviceId)! : this.discovery;
  }
}

async function waitForPendingSleeps(timer: FakeTimer, count: number): Promise<void> {
  for (let turn = 0; turn < 20 && timer.getPendingSleeps().length < count; turn++) {
    await Promise.resolve();
  }
  expect(timer.getPendingSleeps()).toHaveLength(count);
}

describe("AndroidEmulatorClient.getBootedDevicesChecked", () => {
  test("enriches booted emulators concurrently within one probe delay", async () => {
    const timer = new FakeTimer();
    const devices = Array.from({ length: 4 }, (_, index) => ({
      name: "ignored",
      platform: "android" as const,
      deviceId: `emulator-${5554 + index * 2}`,
    }));
    const concurrency: AvdProbeConcurrency = { active: 0, maximum: 0 };
    const delays = new Map(devices.map((device) => [device.deviceId, 50]));
    const client = new AndroidEmulatorClient(
      null,
      null,
      timer,
      new DelayedAvdNameAdbFactory(devices, timer, delays, concurrency),
      new FakeAvdConfigReader(null),
    );

    const discovery = client.getBootedDevicesChecked();
    await waitForPendingSleeps(timer, devices.length);
    expect(concurrency.maximum).toBe(4);

    timer.advanceTime(50);
    await expect(discovery).resolves.toHaveLength(4);
    expect(timer.now()).toBe(50);
  });

  test("isolates an AVD-name failure and preserves input order across parallel probes", async () => {
    const timer = new FakeTimer();
    const devices = [
      { name: "ignored", platform: "android" as const, deviceId: "emulator-5554" },
      { name: "ignored", platform: "android" as const, deviceId: "emulator-5556" },
      { name: "ignored", platform: "android" as const, deviceId: "emulator-5558" },
      { name: "ignored", platform: "android" as const, deviceId: "emulator-5560" },
    ];
    const concurrency: AvdProbeConcurrency = { active: 0, maximum: 0 };
    const delays = new Map([
      ["emulator-5554", 40],
      ["emulator-5556", 10],
      ["emulator-5558", 30],
      ["emulator-5560", 20],
    ]);
    const client = new AndroidEmulatorClient(
      null,
      null,
      timer,
      new DelayedAvdNameAdbFactory(devices, timer, delays, concurrency, "emulator-5558"),
      new FakeAvdConfigReader(null),
    );

    const discovery = client.getBootedDevicesChecked();
    await waitForPendingSleeps(timer, devices.length);
    timer.advanceTime(40);

    await expect(discovery).resolves.toEqual([
      expect.objectContaining({ deviceId: "emulator-5554", name: "AVD_emulator-5554" }),
      expect.objectContaining({ deviceId: "emulator-5556", name: "AVD_emulator-5556" }),
      expect.objectContaining({ deviceId: "emulator-5558", name: "Unknown (emulator-5558)" }),
      expect.objectContaining({ deviceId: "emulator-5560", name: "AVD_emulator-5560" }),
    ]);
    expect(concurrency.maximum).toBe(4);
  });

  test("exposes a cached getprop model on a booted emulator", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      { name: "ignored", platform: "android", deviceId: "emulator-5554" } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("emu avd name", execResult("Pixel_9_API_36\n"));
    adb.setCommandResponse("shell getprop ro.product.model", execResult("sdk_gphone64_arm64\n"));
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      expect.objectContaining({ model: "sdk_gphone64_arm64" }),
    ]);
    await client.getBootedDevicesChecked();

    expect(
      adb.getExecutedCommands().filter((command) => command === "shell getprop ro.product.model"),
    ).toHaveLength(1);
  });

  test("uses cached CPU ABI metadata for a physical device without an AVD image", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      { name: "ignored", platform: "android", deviceId: "R58M12ABCDE" } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("shell getprop ro.product.model", execResult("Pixel 9\n"));
    adb.setCommandResponse("shell getprop ro.product.cpu.abi", execResult("arm64-v8a\n"));
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      expect.objectContaining({
        name: "Pixel 9",
        model: "Pixel 9",
        architecture: "arm64-v8a",
      }),
    ]);
    await client.getBootedDevicesChecked();

    expect(
      adb.getExecutedCommands().filter((command) => command === "shell getprop ro.product.cpu.abi"),
    ).toHaveLength(1);
  });

  test("uses the configured system-image ABI for an AVD image", async () => {
    const config = new FakeAvdConfigReader({
      systemImagePackage: "system-images;android-36;google_apis;arm64-v8a",
      architecture: "arm64",
    });
    const client = new AndroidEmulatorClient(
      async (_file, args) => execResult(args[0] === "-list-avds" ? "Pixel_9_API_36\n" : ""),
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      config,
    );

    await expect(client.listAvds()).resolves.toEqual([
      expect.objectContaining({
        name: "Pixel_9_API_36",
        architecture: "arm64-v8a",
      }),
    ]);
  });

  test("falls back to the runtime CPU ABI when a booted emulator has no readable AVD config", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      { name: "ignored", platform: "android", deviceId: "emulator-5554" } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("emu avd name", execResult("Pixel_9_API_36\n"));
    adb.setCommandResponse("shell getprop ro.product.cpu.abi", execResult("arm64-v8a\n"));
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      new FakeAvdConfigReader(null),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      expect.objectContaining({ architecture: "arm64-v8a" }),
    ]);
  });

  test("prefers the configured AVD architecture over the runtime ABI for a booted emulator", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      { name: "ignored", platform: "android", deviceId: "emulator-5554" } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("emu avd name", execResult("Pixel_9_API_36\n"));
    adb.setCommandResponse("shell getprop ro.product.cpu.abi", execResult("x86_64\n"));
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      new FakeAvdConfigReader({
        systemImagePackage: "system-images;android-36;google_apis;arm64-v8a",
        architecture: "arm64",
      }),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      expect.objectContaining({ architecture: "arm64-v8a" }),
    ]);
    expect(adb.getExecutedCommands()).not.toContain("shell getprop ro.product.cpu.abi");
  });

  test("stamps an emulator observation after its AVD name resolves", async () => {
    let stamp = 0;
    const observationSequence: DiscoveryObservationSequence = {
      next: () => ++stamp,
    };
    const adb = new SequencedDeferredAvdNameAdbExecutor(observationSequence);
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      observationSequence,
    );

    const discovery = client.getBootedDevicesChecked();
    await adb.avdNameProbeStarted.promise;
    expect(observationSequence.next()).toBe(2);
    adb.resolveAvdName("Pixel_9_Pro");

    await expect(discovery).resolves.toEqual([
      {
        name: "Pixel_9_Pro",
        platform: "android",
        deviceId: "emulator-5554",
        observedAt: 3,
        source: "local",
      },
    ]);
  });

  test("uses the AVD name property when the emulator console returns no name", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("emu avd name", execResult("\n"));
    adb.setCommandResponse(
      "shell getprop ro.boot.qemu.avd_name",
      execResult("Codex_KVM_Verify\nignored trailing output"),
    );
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      {
        name: "Codex_KVM_Verify",
        platform: "android",
        deviceId: "emulator-5554",
        observedAt: expect.any(Number),
        source: "local",
      },
    ]);
    expect(adb.getExecutedCommands()).toEqual([
      "emu avd name",
      "shell getprop ro.boot.qemu.avd_name",
      "shell getprop ro.product.model",
      "shell getprop ro.product.cpu.abi",
    ]);
  });

  test("falls back to a placeholder name when AVD-name lookup fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    adb.setCommandError("emu avd name", new Error("emulator console unavailable"));
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(client.getBootedDevicesChecked()).resolves.toEqual([
      {
        name: "Unknown (emulator-5554)",
        platform: "android",
        deviceId: "emulator-5554",
        observedAt: expect.any(Number),
        source: "local",
      },
    ]);
  });

  test("records console busy state when the failed AVD-name probe runs", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    adb.setCommandError("emu avd name", new Error("emulator console unavailable"));
    const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
    consoleBusy.setBusy("emulator-5554", true);
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      consoleBusy,
    );

    const [discovered] = await client.getBootedDevicesChecked();

    expect(discovered).toMatchObject({
      name: "Unknown (emulator-5554)",
      consoleBusyDuringProbe: true,
    });
  });

  test("does not dispatch AVD-name probes while a listed emulator console is busy", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
    consoleBusy.setBusy("emulator-5554", true);
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      consoleBusy,
    );

    const [discovered] = await client.getBootedDevicesChecked();

    expect(discovered).toMatchObject({
      name: "Unknown (emulator-5554)",
      consoleBusyDuringProbe: true,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("records console busy state when an empty AVD-name probe falls through to an empty property", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    adb.setCommandResponse("emu avd name", execResult(" \n"));
    adb.setCommandResponse("shell getprop ro.boot.qemu.avd_name", execResult("\n"));
    const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
    consoleBusy.setBusy("emulator-5554", true);
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      consoleBusy,
    );

    const [discovered] = await client.getBootedDevicesChecked();

    expect(discovered).toMatchObject({
      name: "Unknown (emulator-5554)",
      consoleBusyDuringProbe: true,
    });
  });

  test("records console activity that completed while the failed AVD-name probe was in flight", async () => {
    const adb = new DeferredAvdNameAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      consoleBusy,
    );

    const discovery = client.getBootedDevicesChecked();
    await adb.avdNameProbeStarted;
    await consoleBusy.runExclusive("emulator-5554", async () => undefined);
    expect(consoleBusy.isBusy("emulator-5554")).toBe(false);
    adb.rejectAvdNameProbe(new Error("emulator console unavailable"));

    const [discovered] = await discovery;

    expect(discovered).toMatchObject({
      name: "Unknown (emulator-5554)",
      consoleBusyDuringProbe: true,
    });
  });

  test("bypasses the device-list cache only when terminating", async () => {
    const adb = new RecordingAdbExecutor();
    adb.setCommandResponse("emu avd name", execResult("Pixel 8\nOK\n"));
    adb.setDevices([
      {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      } satisfies BootedDevice,
    ]);
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await client.getBootedDevices();
    expect(adb.lastDiscoveryOptions).toMatchObject({ throwOnMissingAdb: true });
    expect(adb.lastDiscoveryOptions?.bypassCache).toBeFalsy();

    await client.killDevice({
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    });
    expect(adb.lastDiscoveryOptions).toMatchObject({
      bypassCache: true,
      throwOnMissingAdb: true,
    });
    expect(adb.lastExecuteOptions).toMatchObject({
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
    });
  });

  test("propagates discovery failures during shutdown", async () => {
    const adb = new FailingDiscoveryAdbExecutor();
    const client = new AndroidEmulatorClient(
      null,
      null,
      new FakeTimer(),
      new FakeAdbClientFactory(adb),
    );

    await expect(
      client.killDevice({
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      }),
    ).rejects.toThrow("adb server unavailable");
  });
});
