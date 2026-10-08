import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
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
// this daemon can see before cold-booting an AVD, must never adopt an emulator another live daemon
// drives (or one this daemon's adb cannot see), and must not take a device another daemon drives.
// Emulators the user started by hand, and launches joined in this process, are still adopted.

class FakeForeignDeviceOwnership implements ForeignDeviceOwnership {
  /** Devices another live daemon drives, by owner PID. */
  readonly owners = new Map<string, number>();
  /** Devices whose allocation claim another daemon wins. */
  readonly claimRefused = new Set<string>();
  readonly claims: string[] = [];
  refreshes = 0;
  async refresh(): Promise<void> {
    this.refreshes++;
  }
  foreignOwnerPid(deviceId: string): number | undefined {
    return this.owners.get(deviceId);
  }
  async claim(deviceId: string): Promise<boolean> {
    this.claims.push(deviceId);
    return !this.claimRefused.has(deviceId);
  }
}

const android = (deviceId: string) => ({ deviceId, name: deviceId, platform: "android" as const });
const startableAvd = { name: "spare-avd", platform: "android" as const, isRunning: false };

describe("multi-device allocation on a shared host", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  let ownership: FakeForeignDeviceOwnership;
  let markers: InMemoryDeviceHealthMarkers;
  let pool: DevicePool;

  const setUp = async (pooled: string[], booted: string[] = pooled, bindBase = true) => {
    manager.bootedDevices = booted.map(android);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "shared-host-test", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: ownership,
        deviceHealthMarkers: markers,
      }),
    );
    await pool.initializeWithDevices(pooled.map(android));
    if (bindBase) {
      await pool.bindOrReuseDeviceSession("base", pooled[0], "android");
    }
  };

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager = new FakeDeviceManager();
    ownership = new FakeForeignDeviceOwnership();
    markers = new InMemoryDeviceHealthMarkers();
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const allocate = (
    criteria: boolean,
    timeoutMs = 4_000,
    sessionIds: readonly string[] = ["base", "base:B"],
  ) => {
    let settled = false;
    const result = runWithAbortSignal(new AbortController().signal, () =>
      criteria
        ? pool.assignMultipleDevicesByCriteria(
            sessionIds.map((sessionId) => ({
              sessionId,
              criteria: { platform: "android" as const },
            })),
            timeoutMs,
          )
        : pool.assignMultipleDevices([...sessionIds], timeoutMs, "android"),
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

  test("never adopts an AVD running in another process that this daemon's adb cannot see", async () => {
    await setUp(["d1"]);
    manager.deviceImages = [startableAvd];
    manager.startOutcome = "duplicate-of-external";

    const outcome = String(await settle(allocate(true).result));

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(outcome).toContain("Timed out allocating devices");
    expect(pool.getDevice("spare-avd")).toBeNull();
    expect(sessions.getSession("base:B")).toBeNull();
    expect(pool.getDevice("d1")?.sessionId).toBe("base");
  });

  test("adopts a freshly launched emulator", async () => {
    await setUp(["d1"]);
    manager.deviceImages = [startableAvd];

    const result = (await settle(allocate(true).result)) as Map<string, string>;

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(result.get("base:B")).toBe("spare-avd");
  });

  for (const startOutcome of [
    "already-running",
    "joined-in-process-launch",
    "duplicate-of-external",
  ] as const) {
    test(`adopts an emulator the start found ${startOutcome} with no foreign owner`, async () => {
      // e.g. an emulator the user started by hand, visible to this daemon's adb.
      await setUp(["d1"]);
      manager.deviceImages = [startableAvd];
      manager.startOutcome = startOutcome;
      manager.startVisibleDeviceId = "emulator-5560";

      const result = (await settle(allocate(true).result)) as Map<string, string>;

      expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
      expect(result.get("base:B")).toBe("emulator-5560");
      expect(ownership.claims).toContain("emulator-5560");
    });
  }

  for (const startOutcome of ["already-running", "duplicate-of-external"] as const) {
    test(`refuses an emulator found ${startOutcome} that another live daemon drives`, async () => {
      await setUp(["d1"]);
      manager.deviceImages = [startableAvd];
      manager.startOutcome = startOutcome;
      manager.startVisibleDeviceId = "emulator-5560";
      ownership.owners.set("emulator-5560", 4242);

      const outcome = String(await settle(allocate(true).result));

      expect(outcome).toContain("Timed out allocating devices");
      expect(pool.getDevice("emulator-5560")?.sessionId ?? null).toBeNull();
      expect(sessions.getSession("base:B")).toBeNull();
    });
  }

  test("platform allocation boots a startable image instead of waiting on another daemon's device", async () => {
    await setUp(["d1", "d2"]);
    ownership.owners.set("d2", 4242);
    manager.deviceImages = [startableAvd];

    const result = (await settle(allocate(false).result)) as Map<string, string>;

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(result.get("base:B")).toBe("spare-avd");
    expect(pool.getDevice("d2")?.sessionId).toBeNull();
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

      test("gives a device back when another daemon claimed it first, then takes it once free", async () => {
        await setUp(["d1", "d2"]);
        ownership.claimRefused.add("d2");

        const plan = allocate(criteria, 10_000);
        await drainUntilQuiescent(timer);
        await timer.advanceTimeAsync(2_000);

        expect(plan.isSettled()).toBe(false);
        expect(ownership.claims).toContain("d2");
        expect(pool.getDevice("d2")?.sessionId).toBeNull();
        expect(sessions.getSession("base:B")).toBeNull();

        ownership.claimRefused.delete("d2");
        const result = (await settle(plan.result)) as Map<string, string>;
        expect(result.get("base:B")).toBe("d2");
      });

      test("waits for another daemon's device instead of failing on an unhealthy one", async () => {
        // No device of this pool is busy, so only d2 (another daemon's) can free up.
        await setUp(["d1", "d2"], ["d1", "d2"], false);
        const incarnation = pool.getDeviceIncarnation("d1");
        if (incarnation === undefined) {
          throw new Error("expected pooled device incarnation");
        }
        markers.mark("d1", incarnation, "clock");
        ownership.owners.set("d2", 4242);

        const plan = allocate(criteria, 10_000, ["plan:A"]);
        await drainUntilQuiescent(timer);
        await timer.advanceTimeAsync(2_000);

        expect(plan.isSettled()).toBe(false);

        ownership.owners.delete("d2");
        const result = (await settle(plan.result)) as Map<string, string>;
        expect(result.get("plan:A")).toBe("d2");
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
