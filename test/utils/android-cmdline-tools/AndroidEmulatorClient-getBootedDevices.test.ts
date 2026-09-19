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

describe("AndroidEmulatorClient.getBootedDevicesChecked", () => {
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
