import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
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

/**
 * Drives a freshly-created AVD whose serial sits in ADB `offline`. The fake can
 * optionally flip the serial to `device` once `adb reconnect offline` runs, so
 * a test can assert either sustained-offline failure or a successful recovery.
 */
class FreshOfflineAdbExecutor extends FakeAdbExecutor {
  reconnectCalls = 0;
  private recoverOnReconnect = false;

  configureRecoveryFlipsOnline(): void {
    this.recoverOnReconnect = true;
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (command.includes("reconnect offline")) {
      this.reconnectCalls += 1;
      if (this.recoverOnReconnect) {
        this.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
        this.setDevices([
          {
            name: "Pixel_9_Pro",
            platform: "android",
            deviceId: "emulator-5554",
            source: "local",
          },
        ]);
      }
    }
    return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }
}

class FreshOfflineAdbFactory implements AdbClientFactory {
  constructor(private readonly adb: AdbExecutor) {}

  create(): AdbExecutor {
    return this.adb;
  }
}

function clientWith(adb: FreshOfflineAdbExecutor, timer: FakeTimer): AndroidEmulatorClient {
  return new AndroidEmulatorClient(
    async () => result(),
    null,
    timer,
    new FreshOfflineAdbFactory(adb),
  );
}

function configureReadyProbes(adb: FreshOfflineAdbExecutor): void {
  adb.setCommandResponse("emu avd name", result("Pixel_9_Pro\n"));
  adb.setCommandResponse("get-state", result("device\n"));
  adb.setCommandResponse("shell pm list packages", result("package:android\n"));
  adb.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
  adb.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
}

const OFFLINE_STATE: AdbDeviceState[] = [{ deviceId: "emulator-5554", state: "offline" }];

describe("Android emulator fresh-provision offline recovery", () => {
  let previousPollingInterval: string | undefined;

  beforeEach(() => {
    previousPollingInterval = process.env.EMULATOR_POLLING_INTERVAL_MS;
    // Fewer, larger poll cycles keep the fake-timer walk to the recovery
    // threshold short so the test stays well under the 100ms unit budget.
    process.env.EMULATOR_POLLING_INTERVAL_MS = "5000";
  });

  afterEach(() => {
    if (previousPollingInterval === undefined) {
      delete process.env.EMULATOR_POLLING_INTERVAL_MS;
    } else {
      process.env.EMULATOR_POLLING_INTERVAL_MS = previousPollingInterval;
    }
  });

  test("recovers a fresh AVD when 'adb reconnect offline' brings the serial online", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);
    adb.configureRecoveryFlipsOnline();

    const device = await clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      120_000,
      null,
      "emulator-5554",
      undefined,
      { freshProvision: true },
    );

    expect(device.deviceId).toBe("emulator-5554");
    expect(adb.reconnectCalls).toBeGreaterThanOrEqual(1);
    expect(timer.now()).toBeLessThan(120_000);
  });

  test("fails a sustained-offline fresh AVD with a recovery diagnostic before the full budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);

    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      120_000,
      null,
      "emulator-5554",
      undefined,
      { freshProvision: true },
    );

    await expect(readiness).rejects.toThrow("state=offline");
    await expect(readiness).rejects.toThrow("adb reconnect offline");
    await readiness.catch(() => undefined);
    expect(adb.reconnectCalls).toBeGreaterThanOrEqual(1);
    expect(timer.now()).toBeLessThan(120_000);
  });

  test("quick-boot (non-fresh) offline takes the wait-out branch: no reconnect, generic timeout", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);

    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      100,
      null,
      "emulator-5554",
    );

    await expect(readiness).rejects.toThrow("target=emulator-5554; state=offline");
    await expect(readiness).rejects.not.toThrow("adb reconnect offline");
    await readiness.catch(() => undefined);
    expect(adb.reconnectCalls).toBe(0);
  });
});
