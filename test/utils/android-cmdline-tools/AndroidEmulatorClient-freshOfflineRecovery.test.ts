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
  /** Fake-clock time at which the most recent `adb reconnect offline` settled. */
  reconnectSettledAt: number | null = null;
  private recoverOnReconnect = false;
  private reconnectDurationMs = 0;
  private timer: FakeTimer | null = null;
  private deviceStateCalls = 0;
  private rejectDeviceStatesAfter: number | null = null;
  private rejectOnceAfterReconnect = false;
  private pendingRejectAfterReconnect = false;

  configureRecoveryFlipsOnline(): void {
    this.recoverOnReconnect = true;
  }

  /**
   * Make the fake `adb reconnect offline` consume `ms` of fake time before it
   * settles (mirroring a reconnect that runs near its 5s command timeout), so a
   * test can prove the recovery grace only starts once the command returns.
   */
  configureReconnectDuration(timer: FakeTimer, ms: number): void {
    this.timer = timer;
    this.reconnectDurationMs = ms;
  }

  /**
   * Return `offline` for the first `count` device-state probes, then REJECT
   * every subsequent probe (e.g. an ADB-server restart tearing down the
   * connection). Models a cached-offline observation followed by a run of
   * failing probes that must not, by themselves, drive recovery.
   */
  configureDeviceStateRejectAfter(count: number): void {
    this.rejectDeviceStatesAfter = count;
  }

  /**
   * After the first `adb reconnect offline` settles, REJECT exactly one
   * subsequent device-state probe (an ADB-server blip during the recovery
   * grace), then resume reporting `offline`. Models a probe gap that must not
   * wipe the one-shot recovery history and let a re-confirmed offline start a
   * fresh episode with a SECOND reconnect (#7054).
   */
  configureRejectOnceAfterReconnect(): void {
    this.rejectOnceAfterReconnect = true;
  }

  override async getDeviceStates(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<AdbDeviceState[]> {
    this.deviceStateCalls += 1;
    if (this.pendingRejectAfterReconnect) {
      this.pendingRejectAfterReconnect = false;
      throw new Error("adb server connection reset after reconnect; device state unavailable");
    }
    if (
      this.rejectDeviceStatesAfter !== null &&
      this.deviceStateCalls > this.rejectDeviceStatesAfter
    ) {
      throw new Error("adb server killed by remote request; device state unavailable");
    }
    return super.getDeviceStates(options);
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
      if (this.rejectOnceAfterReconnect) {
        // Fire the probe gap only after the FIRST reconnect.
        this.rejectOnceAfterReconnect = false;
        this.pendingRejectAfterReconnect = true;
      }
      if (this.reconnectDurationMs > 0 && this.timer) {
        await this.timer.sleep(this.reconnectDurationMs);
      }
      if (this.timer) {
        this.reconnectSettledAt = this.timer.now();
      }
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

  test("failing device-state probes after a cached offline do NOT drive recovery", async () => {
    // THREAD 1 (#7054): once a serial is observed offline and getDeviceStates
    // then starts REJECTING (e.g. an ADB-server restart), a run of failed
    // probes must not stand in for a current offline observation. Recovery must
    // wait for a fresh, successful probe that still shows offline; otherwise it
    // dispatches a reconnect and raises a state=offline failure off stale data.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);
    // One successful offline observation, then every probe rejects.
    adb.configureDeviceStateRejectAfter(1);

    // Budget comfortably past the 15s recovery threshold + 5s grace so that,
    // under the pre-fix behavior, the reconnect + state=offline diagnostic
    // would already have fired well before this deadline.
    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      30_000,
      null,
      "emulator-5554",
      undefined,
      { freshProvision: true },
    );

    await expect(readiness).rejects.toThrow();
    // A run of failed probes must never satisfy the offline-failure threshold.
    await expect(readiness).rejects.not.toThrow("adb reconnect offline");
    await readiness.catch(() => undefined);
    expect(adb.reconnectCalls).toBe(0);
  });

  test("a slow reconnect does not exhaust the grace: the grace starts after it settles", async () => {
    // THREAD 2 (#7054): recoveryAt must be recorded AFTER `adb reconnect
    // offline` settles. If it is recorded before the awaited command, a
    // reconnect that runs near its 5s timeout eats the whole 5s grace and the
    // next poll fails fast immediately, giving the device no time to come back.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);
    // Reconnect consumes ~5s (its command timeout); poll faster than that so a
    // poll lands inside the window the pre-fix bug would have already skipped.
    adb.configureReconnectDuration(timer, 5000);
    process.env.EMULATOR_POLLING_INTERVAL_MS = "1000";

    const readiness = clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      120_000,
      null,
      "emulator-5554",
      undefined,
      { freshProvision: true },
    );

    await expect(readiness).rejects.toThrow("adb reconnect offline");
    await readiness.catch(() => undefined);
    expect(adb.reconnectCalls).toBe(1);
    expect(adb.reconnectSettledAt).not.toBeNull();
    // The full 5s grace (FRESH_OFFLINE_RECOVERY_GRACE_MS) must elapse AFTER the
    // reconnect settled before the fail-fast diagnostic is raised.
    expect(timer.now() - (adb.reconnectSettledAt ?? 0)).toBeGreaterThanOrEqual(5000);
  });

  test("issues the recovery reconnect with retries disabled (noRetry)", async () => {
    // THREAD 3 (#7054): the one-shot reconnect must pass noRetry=true so the
    // real AdbClient does not route it through the retry executor (up to 4
    // executions), which would contradict the one-reconnect-per-episode
    // contract tracked by recoveryAttempted.
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

    await expect(readiness).rejects.toThrow("adb reconnect offline");
    await readiness.catch(() => undefined);

    const reconnectCalls = adb
      .getCommandCalls()
      .filter((call) => call.command.includes("reconnect offline"));
    expect(reconnectCalls).toHaveLength(1);
    expect(reconnectCalls[0]?.noRetry).toBe(true);
  });

  test("a probe gap after the first reconnect does NOT resurrect a second reconnect", async () => {
    // REGRESSION (#7054): the round-2 clearOfflineTracker() also wiped
    // recoveryAttempted/recoveryAt. So once the first `adb reconnect offline`
    // was dispatched, a probe that rejects/omits the target and then re-reports
    // offline was treated as a brand-new offline episode: it restarted the 15s
    // threshold and issued a SECOND reconnect, breaking the one-shot-recovery-
    // per-readiness-invocation contract. The recovery history must be MONOTONIC
    // for the lifetime of a single waitForEmulatorReady invocation, so a probe
    // gap clears only the current observation and the re-confirmed offline
    // continues toward the fail-fast (grace after the first reconnect).
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FreshOfflineAdbExecutor();
    adb.setDeviceStates(OFFLINE_STATE);
    adb.setDevices([]);
    configureReadyProbes(adb);
    // Sustained offline (never flips online), but the probe right after the
    // first reconnect rejects once before offline is re-reported.
    adb.configureRejectOnceAfterReconnect();

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
    // Exactly one reconnect per readiness invocation, despite the probe gap.
    expect(adb.reconnectCalls).toBe(1);
    // Fails well before a second 15s episode (~t=40s pre-fix) could complete.
    expect(timer.now()).toBeLessThan(40_000);
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
