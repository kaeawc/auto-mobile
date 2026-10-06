import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// #10153: a plan whose base session already holds a device cannot be allocated
// when no other matching device is idle. It must fail at once, not wait out the
// allocation timeout (which outlived the client's own timeout).
const ALLOCATION_TIMEOUT_MS = 300_000;

for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} allocation while the caller holds a device`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let pool: DevicePool;

    const setUp = async (deviceIds: string[]) => {
      timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const discovery = new FakeDeviceManager(
        [],
        deviceIds.map((deviceId) => ({ deviceId, name: deviceId, platform: "android" })),
      );
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "caller-held", {
          timer,
          deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
          deviceManager: discovery,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          retryExecutor: new DefaultRetryExecutor(timer),
        }),
      );
      await pool.initializeWithDevices(discovery.bootedDevices);
    };

    afterEach(async () => {
      await drainUntilQuiescent(timer);
      sessions.stopCleanupTimer();
      timer.reset();
    });

    // The plan's labels: the base session (label A) plus derived label sessions.
    const allocate = (ids: string[]) => {
      let settled = false;
      let outcome: unknown;
      const run = criteria
        ? pool.assignMultipleDevicesByCriteria(
            ids.map((sessionId) => ({ sessionId, criteria: { platform: "android" as const } })),
            ALLOCATION_TIMEOUT_MS,
          )
        : pool.assignMultipleDevices(ids, ALLOCATION_TIMEOUT_MS, "android");
      void run.then(
        (value) => {
          settled = true;
          outcome = value;
        },
        (error: unknown) => {
          settled = true;
          outcome = error;
        },
      );
      return { settled: () => settled, outcome: () => outcome };
    };

    const release = async (sessionId: string) => {
      const deviceId = sessions.getSession(sessionId)?.assignedDevice;
      if (!deviceId) {
        throw new Error(`Missing session ${sessionId}`);
      }
      await sessions.releaseSession(sessionId);
      await pool.releaseDevice(deviceId, sessionId);
    };

    test("fails at once when the caller holds the only matching device", async () => {
      await setUp(["a"]);
      await pool.bindOrReuseDeviceSession("base", "a", "android");

      const run = allocate(["base"]);
      await drainUntilQuiescent(timer);

      expect(run.settled()).toBe(true);
      expect(run.outcome()).toBeInstanceOf(ActionableError);
      const message = (run.outcome() as ActionableError).message;
      expect(message).toContain("needs 1 device(s)");
      expect(message).toContain("0 matching device(s) are idle");
      expect(message).toContain("calling session already holds a (session base)");
      // The caller keeps its device and nothing is left reserved.
      expect(pool.getDevice("a")?.sessionId).toBe("base");
      expect(sessions.getSession("base")?.assignedDevice).toBe("a");
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.now()).toBe(0);
    });

    test("fails at once naming the live session that holds the other device", async () => {
      await setUp(["a", "b"]);
      await pool.bindOrReuseDeviceSession("base", "a", "android");
      await pool.bindOrReuseDeviceSession("other-client", "b", "android");

      const run = allocate(["base", "base:B"]);
      await drainUntilQuiescent(timer);

      expect(run.settled()).toBe(true);
      const message = (run.outcome() as ActionableError).message;
      expect(message).toContain("needs 2 device(s)");
      expect(message).toContain("0 matching device(s) are idle");
      expect(message).toContain("calling session already holds a (session base)");
      expect(message).toContain("b is held by session other-client");
      expect(pool.getDevice("a")?.sessionId).toBe("base");
      expect(pool.getDevice("b")?.sessionId).toBe("other-client");
      expect(sessions.getSession("base:B")).toBeNull();
      expect(timer.now()).toBe(0);
    });

    test("allocates when the caller holds one device and another is idle", async () => {
      await setUp(["a", "b"]);
      await pool.bindOrReuseDeviceSession("base", "a", "android");

      const run = allocate(["base", "base:B"]);
      await drainUntilQuiescent(timer);

      const assignments = run.outcome() as Map<string, string>;
      expect(assignments.get("base")).toBe("a");
      expect(assignments.get("base:B")).toBe("b");
    });

    test("keeps waiting while the other device belongs to a running plan, then allocates", async () => {
      await setUp(["a", "b"]);
      await pool.bindOrReuseDeviceSession("base", "a", "android");
      await pool.bindOrReuseDeviceSession("plan-base", "b", "android");
      // Another plan's base session: its device frees when that plan ends.
      sessions.setDeviceLabels("plan-base", { A: "plan-base" });

      const run = allocate(["base", "base:B"]);
      await drainUntilQuiescent(timer);
      expect(run.settled()).toBe(false);

      timer.advanceTime(3_000);
      await drainUntilQuiescent(timer);
      expect(run.settled()).toBe(false);

      await release("plan-base");
      await drainUntilQuiescent(timer);

      const assignments = run.outcome() as Map<string, string>;
      expect(assignments.get("base")).toBe("a");
      expect(assignments.get("base:B")).toBe("b");
    });

    test("a request with no session of its own still waits for a directly held device", async () => {
      await setUp(["a"]);
      await pool.bindOrReuseDeviceSession("owner", "a", "android");

      const run = allocate(["fresh"]);
      await drainUntilQuiescent(timer);
      expect(run.settled()).toBe(false);

      await release("owner");
      await drainUntilQuiescent(timer);
      expect((run.outcome() as Map<string, string>).get("fresh")).toBe("a");
    });
  });
}
