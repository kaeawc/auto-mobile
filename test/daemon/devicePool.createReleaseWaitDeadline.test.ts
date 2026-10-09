import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { CREATE_SESSION_RELEASE_WAIT_MS, DevicePool } from "../../src/daemon/devicePool";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
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

/** Stands in for a release whose teardown never settles: the wait only ends at its deadline. */
class NeverSettlingReleaseManager extends SessionManager {
  readonly waits: number[] = [];
  stuck = false;

  constructor(private readonly fakeTimer: FakeTimer) {
    super(fakeTimer, new FakeDeviceSessionPersistence(), () => new FakeDbWriteBarrier());
  }

  override async waitForSessionReleaseWithin(sessionId: string, timeoutMs: number) {
    if (!this.stuck) {
      return super.waitForSessionReleaseWithin(sessionId, timeoutMs);
    }
    this.waits.push(timeoutMs);
    return new Promise<boolean>((resolve) => {
      this.fakeTimer.setTimeout(() => resolve(false), timeoutMs);
    });
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

async function poolFor(manager: SessionManager, timer: FakeTimer): Promise<DevicePool> {
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [first, second]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "create-release-wait-deadline", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
    }),
  );
  await pool.initializeWithDevices([first, second]);
  return pool;
}

function track<T>(promise: Promise<T>): { state: () => string } {
  let state = "pending";
  promise.then(
    () => {
      state = "resolved";
    },
    (error: unknown) => {
      state = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  return { state: () => state };
}

describe("createSessionOrRestore's release wait is bounded (#10836)", () => {
  test("a create racing a release whose write is wedged does not hold the assignment mutex past the deadline", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      const persistence = new ParkablePersistence();
      const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
      const pool = await poolFor(manager, timer);
      const createGate = Promise.withResolvers<void>();
      persistence.parkCreate = createGate.promise;

      const bind = track(pool.bindOrReuseDeviceSession("racing", first.deviceId, "android"));
      await flush();
      persistence.parkRelease = new Promise<void>(() => {});
      const release = track(manager.releaseSession("racing", "explicit-release"));
      await flush();
      persistence.parkCreate = undefined;
      createGate.resolve();
      await flush();
      const unrelated = track(pool.assignDeviceToSession("unrelated", "android"));
      await flush();
      // The create holds the assignment mutex while it waits on the racing release.
      expect(unrelated.state()).toBe("pending");

      await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await flush();

      expect(release.state()).toBe("resolved");
      expect(bind.state()).toStartWith("rejected");
      expect(unrelated.state()).toBe("resolved");
      expect(pool.getDevice(first.deviceId)?.sessionId ?? null).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("a release that never settles makes the create refuse at the deadline and frees the mutex", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      const manager = new NeverSettlingReleaseManager(timer);
      const pool = await poolFor(manager, timer);
      const acquisitionCancellations: string[] = [];
      manager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
        acquisitionCancellations.push(deviceId);
      });
      manager.stuck = true;

      const bind = pool
        .bindOrReuseDeviceSession("stuck", first.deviceId, "android")
        .catch((error: unknown) => error);
      await flush();
      const unrelated = track(pool.assignDeviceToSession("unrelated", "android"));
      await timer.advanceTimeAsync(CREATE_SESSION_RELEASE_WAIT_MS - 1);
      await flush();
      expect(unrelated.state()).toBe("pending");

      manager.stuck = false;
      await timer.advanceTimeAsync(1);
      const error = await bind;

      expect(manager.waits).toEqual([CREATE_SESSION_RELEASE_WAIT_MS]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Retry the request");
      expect(pool.getDevice(first.deviceId)?.sessionId ?? null).toBeNull();
      await flush();
      expect(unrelated.state()).toBe("resolved");
      // The refused create leaves its device free: only the unrelated committed create cancels
      // sessionless calls, on its own device (#10905).
      expect(acquisitionCancellations).toEqual([second.deviceId]);
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("reason=create-release-wait-timeout"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a create with no racing release proceeds without waiting", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000);
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const pool = await poolFor(manager, timer);
    const acquisitionCancellations: Array<[string, string]> = [];
    manager.setDeviceAcquisitionExecutionCanceller((deviceId, sessionId) => {
      acquisitionCancellations.push([deviceId, sessionId]);
    });

    await pool.bindOrReuseDeviceSession("plain", first.deviceId, "android");

    expect(pool.getDevice(first.deviceId)?.sessionId).toBe("plain");
    // A committed create still cancels sessionless calls on its device, once (#10905).
    expect(acquisitionCancellations).toEqual([[first.deviceId, "plain"]]);
  });
});
