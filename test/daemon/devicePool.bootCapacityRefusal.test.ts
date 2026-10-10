import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceInfo } from "../../src/models";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #11236: a boot refused at the booted-device limit was swallowed by the pool's
// start-additional paths, which then reported a generic "not enough devices"
// (and dropped the count of devices they had already started).

const android = (deviceId: string) => ({ deviceId, name: deviceId, platform: "android" as const });
const avd = (name: string) => ({ name, platform: "android" as const, isRunning: false });

/** Admits `admitted` boots, then refuses every further boot at the limit. */
class CapacityLimitedDeviceManager extends FakeDeviceManager {
  constructor(private admitted: number) {
    super();
  }

  override async startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess | null> {
    if (this.admitted <= 0) {
      throw new BootCapacityExhaustedError(
        { platform: "android", limit: 2, booted: 2, retryAfterMs: 5_000 },
        "Refused to boot: no Android capacity",
      );
    }
    this.admitted--;
    return await super.startDevice(device, timeoutMs);
  }
}

describe("device pool start-additional at the boot capacity limit", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: CapacityLimitedDeviceManager;
  let pool: DevicePool;

  const createPool = async (admitted: number) => {
    manager = new CapacityLimitedDeviceManager(admitted);
    manager.bootedDevices = [android("d1")];
    manager.deviceImages = [avd("spare-a"), avd("spare-b")];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "capacity-refusal-test", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([android("d1")]);
  };

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const settle = (allocation: () => Promise<unknown>) =>
    settleWithFakeTime(
      timer,
      runWithAbortSignal(new AbortController().signal, allocation).then(
        (value: unknown) => value,
        (error: unknown) => error,
      ),
      { stepMs: 1_000, maxSteps: 8, description: "allocation outcome" },
    );

  test("platform allocation fails with the typed refusal", async () => {
    await createPool(0);

    const outcome = await settle(() =>
      pool.assignMultipleDevices(["s1", "s2", "s3"], 4_000, "android"),
    );

    expect(outcome).toBeInstanceOf(BootCapacityExhaustedError);
    expect(outcome).toMatchObject({ code: "capacity_exhausted", retryable: true });
  });

  test("platform allocation keeps and counts a device it started before the refusal", async () => {
    await createPool(1);

    const outcome = await settle(() =>
      pool.assignMultipleDevices(["s1", "s2", "s3"], 4_000, "android"),
    );

    expect(outcome).toBeInstanceOf(BootCapacityExhaustedError);
    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-a"]);
    expect(pool.getDevice("spare-a")).toBeDefined();
    expect(pool.getStatsForPlatform("android").total).toBe(2);
  });

  test("criteria allocation fails with the typed refusal", async () => {
    await createPool(1);

    const outcome = await settle(() =>
      pool.assignMultipleDevicesByCriteria(
        ["s1", "s2", "s3"].map((sessionId) => ({
          sessionId,
          criteria: { platform: "android" as const },
        })),
        4_000,
      ),
    );

    expect(outcome).toBeInstanceOf(BootCapacityExhaustedError);
    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-a"]);
    expect(pool.getDevice("spare-a")).toBeDefined();
  });
});
