import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

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

describe("AndroidEmulatorClient.getBootedDevicesChecked", () => {
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
        source: "local",
      },
    ]);
    expect(adb.getExecutedCommands()).toEqual([
      "emu avd name",
      "shell getprop ro.boot.qemu.avd_name",
    ]);
  });

  test("preserves transport identity when AVD-name lookup fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([
      {
        name: "ignored",
        platform: "android",
        deviceId: "emulator-5554",
        transportId: "42",
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
        transportId: "42",
        source: "local",
      },
    ]);
  });

  test("bypasses the device-list cache only when terminating", async () => {
    const adb = new RecordingAdbExecutor();
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
