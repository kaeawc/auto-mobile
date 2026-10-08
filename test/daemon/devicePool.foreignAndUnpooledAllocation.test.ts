import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";

// mt-0083 D2: a two-label plan whose base session holds one device must use another booted device
// this daemon can see before cold-booting an AVD, must never adopt an AVD another process already
// runs, and must not take a device another live daemon drives.

class FakeForeignDeviceOwnership implements ForeignDeviceOwnership {
  readonly owners = new Map<string, number>();
  foreignOwnerPid(deviceId: string): number | undefined {
    return this.owners.get(deviceId);
  }
}

const android = (deviceId: string) => ({ deviceId, name: deviceId, platform: "android" as const });
const startableAvd = { name: "spare-avd", platform: "android" as const, isRunning: false };

describe("multi-device allocation on a shared host", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  let ownership: FakeForeignDeviceOwnership;
  let pool: DevicePool;

  const setUp = async (pooled: string[], booted: string[] = pooled) => {
    manager.bootedDevices = booted.map(android);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "shared-host-test", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: ownership,
      }),
    );
    await pool.initializeWithDevices(pooled.map(android));
    await pool.bindOrReuseDeviceSession("base", pooled[0], "android");
  };

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager = new FakeDeviceManager();
    ownership = new FakeForeignDeviceOwnership();
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const allocate = (criteria: boolean, timeoutMs = 4_000) => {
    let settled = false;
    const result = runWithAbortSignal(new AbortController().signal, () =>
      criteria
        ? pool.assignMultipleDevicesByCriteria(
            ["base", "base:B"].map((sessionId) => ({
              sessionId,
              criteria: { platform: "android" as const },
            })),
            timeoutMs,
          )
        : pool.assignMultipleDevices(["base", "base:B"], timeoutMs, "android"),
    ).then(
      (value: unknown) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    return { result, isSettled: () => settled };
  };
  const settle = (result: Promise<unknown>) =>
    settleWithFakeTime(timer, result, {
      stepMs: 1_000,
      maxSteps: 8,
      description: "allocation outcome",
    });

  test("re-pools a booted idle device instead of cold-booting an AVD", async () => {
    // d2 is booted and idle but was dropped from the pool (e.g. after a reboot).
    await setUp(["d1"], ["d1", "d2"]);
    manager.deviceImages = [startableAvd];

    const result = (await settle(allocate(true).result)) as Map<string, string>;

    expect(manager.startedDevices).toEqual([]);
    expect(result.get("base")).toBe("d1");
    expect(result.get("base:B")).toBe("d2");
  });

  test("never adopts an AVD another process already runs", async () => {
    await setUp(["d1"]);
    manager.deviceImages = [startableAvd];
    manager.startAdoptsForeignEmulator = true;

    const outcome = String(await settle(allocate(true).result));

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(outcome).toContain("Timed out allocating devices");
    expect(pool.getDevice("spare-avd")).toBeNull();
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("d1")?.sessionId).toBe("base");
  });

  for (const criteria of [true, false]) {
    describe(`${criteria ? "criteria" : "platform"} allocation`, () => {
      test("waits instead of taking an idle device another live daemon drives", async () => {
        await setUp(["d1", "d2"]);
        ownership.owners.set("d2", 4242);

        const plan = allocate(criteria, 10_000);
        await drainUntilQuiescent(timer);
        await timer.advanceTimeAsync(2_000);

        expect(plan.isSettled()).toBe(false);
        expect(pool.getDevice("d2")?.sessionId).toBeNull();

        // The other daemon lets the device go; the waiting plan now claims it.
        ownership.owners.delete("d2");
        const result = (await settle(plan.result)) as Map<string, string>;
        expect(result.get("base:B")).toBe("d2");
      });

      test("prefers a device no other daemon drives", async () => {
        await setUp(["d1", "d2", "d3"]);
        ownership.owners.set("d2", 4242);

        const result = (await settle(allocate(criteria).result)) as Map<string, string>;

        expect(result.get("base:B")).toBe("d3");
        expect(pool.getDevice("d2")?.sessionId).toBeNull();
      });
    });
  }
});
