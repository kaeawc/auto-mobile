import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  SESSION_CREATION_TIMEOUT_CODE,
  SessionCreationTimeoutError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { forceStuckSessionRelease } from "../../src/daemon/releaseSessionAndDevice";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import {
  SESSION_CREATE_WAIT_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #10963: a wedged create-time DB write must not hold the pool's assignment mutex forever, and a
// reap stuck past its deadline must free its device while the session stays fenced.

const first = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const second = { deviceId: "emulator-5556", name: "Pixel B", platform: "android" as const };
const flush = async () => {
  for (let index = 0; index < 200; index++) {
    await Promise.resolve();
  }
};

/** Session creates and release writes can each be parked, like a wedged SQLite write. */
class ParkablePersistence extends FakeDeviceSessionPersistence {
  parkCreate: Promise<void> | undefined;
  parkRelease: Promise<void> | undefined;

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    await this.parkCreate;
    await super.upsertActiveSession(record);
  }

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    await this.parkRelease;
    await super.markReleased(sessionUuid, status, releasedAtMs, reason);
  }
}

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.reset();
});

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const persistence = new ParkablePersistence();
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [first, second]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "create-stuck-reap-deadline", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
    }),
  );
  await pool.initializeWithDevices([first, second]);
  return { timer, persistence, manager, pool };
}

function track<T>(promise: Promise<T>): { state: () => string; error: () => unknown } {
  let state = "pending";
  let failure: unknown;
  promise.then(
    () => {
      state = "resolved";
    },
    (error: unknown) => {
      state = "rejected";
      failure = error;
    },
  );
  return { state: () => state, error: () => failure };
}

describe("a wedged create-time DB write is bounded (#10963)", () => {
  test("an unrelated assignment resolves within the bound and the parked claim is rolled back", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      const createGate = Promise.withResolvers<void>();
      h.persistence.parkCreate = createGate.promise;

      const bind = track(h.pool.bindOrReuseDeviceSession("wedged", first.deviceId, "android"));
      await flush();
      // Only the bind's own write is wedged; it already waits on the gate.
      h.persistence.parkCreate = undefined;
      const unrelated = track(h.pool.assignDeviceToSession("unrelated", "android"));
      await flush();
      expect(unrelated.state()).toBe("pending");

      await h.timer.advanceTimeAsync(SESSION_CREATE_WAIT_TIMEOUT_MS - 1);
      await flush();
      expect(bind.state()).toBe("pending");

      await h.timer.advanceTimeAsync(1);
      await flush();
      expect(bind.state()).toBe("rejected");
      expect(bind.error()).toBeInstanceOf(SessionCreationTimeoutError);
      expect(bind.error()).toMatchObject({
        code: SESSION_CREATION_TIMEOUT_CODE,
        retryable: true,
        deviceId: first.deviceId,
      });
      expect(h.pool.getDevice(first.deviceId)?.sessionId ?? null).toBeNull();
      expect(unrelated.state()).toBe("resolved");

      // The wedged write lands late: the abandoned creation never publishes, and its row is
      // released so a restart does not rehydrate it.
      createGate.resolve();
      await flush();
      expect(h.manager.getSession("wedged")).toBeNull();
      expect((await h.persistence.getSession!("wedged"))?.status).not.toBe("active");
      expect(h.pool.getDevice(first.deviceId)?.sessionId ?? null).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a reap stuck past its deadline frees the device (#10963)", () => {
  test("the monitor forces a stuck reap once, after the stuck deadline", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await h.pool.bindOrReuseDeviceSession("stuck", first.deviceId, "android");
      const forced: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        h.manager,
        () => false,
        // A reap whose release never settles.
        () => new Promise<void>(() => {}),
        h.timer,
        {
          heartbeatTimeoutMs: 1_000,
          graceMs: 0,
          preFirstHeartbeatGraceMs: 1_000,
          forceStuckRelease: async (sessionId) => {
            forced.push(sessionId);
          },
        },
      );
      monitor.start();
      try {
        await h.timer.advanceTimeAsync(5_000);
        await flush();
        expect(forced).toEqual([]);
        await h.timer.advanceTimeAsync(STUCK_REAP_WARN_MS);
        await flush();
        expect(forced).toEqual(["stuck"]);
        await h.timer.advanceTimeAsync(3 * DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
        await flush();
        expect(forced).toEqual(["stuck"]);
      } finally {
        await h.timer.advanceTimeAsync(10_000);
        void monitor.stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("a forced release fences the session and returns the device after the teardown cap", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await h.pool.bindOrReuseDeviceSession("stuck", first.deviceId, "android");
      h.persistence.parkRelease = new Promise<void>(() => {});
      const releases: string[] = [];
      h.manager.onSessionRelease((sessionId, _deviceId, reason) => {
        releases.push(`${sessionId}:${reason}`);
      });
      void h.manager.releaseSession("stuck", "heartbeat-timeout");
      await flush();

      const forced = h.manager.forceStuckRelease("stuck");
      expect(forced).toEqual({ deviceId: first.deviceId, stage: "terminal-persist" });
      expect(h.manager.forceStuckRelease("stuck")).toBeUndefined();
      expect(h.manager.getSession("stuck")).toBeNull();
      expect(h.manager.getTerminalReleaseSnapshot("stuck")?.terminal).toBe(true);
      expect(releases).toEqual(["stuck:heartbeat-timeout"]);

      const freeing = forceStuckSessionRelease(
        { forceStuckRelease: () => forced },
        h.pool,
        "stuck",
      );
      await flush();
      // Quarantined until the stuck release settles or the teardown cap passes.
      expect(h.pool.getDevice(first.deviceId)?.sessionId).toBe("stuck");

      await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS);
      await freeing;
      await flush();
      expect(h.pool.getDevice(first.deviceId)?.sessionId ?? null).toBeNull();
      await h.pool.bindOrReuseDeviceSession("next", first.deviceId, "android");
      expect(h.pool.getDevice(first.deviceId)?.sessionId).toBe("next");
      // The fenced UUID never routes again.
      await expect(h.manager.getOrCreateSession("stuck")).rejects.toThrow("terminal");
    } finally {
      warn.mockRestore();
    }
  });
});
