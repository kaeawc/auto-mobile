import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
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

const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const flush = async () => {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
  }
};

/** A DB whose release write can be parked, like a wedged SQLite write (#10836). */
class ParkableReleasePersistence extends FakeDeviceSessionPersistence {
  /** While set, `markReleased` waits on this before writing. */
  park: Promise<void> | undefined;
  /** While set, `upsertActiveSession` waits on this before writing. */
  parkCreate: Promise<void> | undefined;
  readonly releaseWrites: string[] = [];

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    await this.park;
    this.releaseWrites.push(`${sessionUuid}:${reason}`);
    await super.markReleased(sessionUuid, status, releasedAtMs, reason);
  }

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    await this.parkCreate;
    await super.upsertActiveSession(record);
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
  const persistence = new ParkableReleasePersistence();
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "release-persist-deadline", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
    }),
  );
  await pool.initializeWithDevices([device]);
  await pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  return { timer, manager, pool, persistence };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The heartbeat monitor's reap: a terminal release followed by the pool release. */
function reap(h: Harness): { done: Promise<void>; settled: () => boolean } {
  let settled = false;
  const done = releaseSessionAndDevice(
    h.manager,
    h.pool,
    device.deviceId,
    "old",
    "heartbeat-timeout",
  ).finally(() => {
    settled = true;
  });
  return { done, settled: () => settled };
}

describe("a release whose DB write never settles is bounded by a deadline (#10836)", () => {
  test("a parked terminal markReleased frees the device at the deadline and keeps the session fenced", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      h.persistence.park = new Promise<void>(() => {});

      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS - 1);
      await flush();
      expect(pending.settled()).toBe(false);
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("old");

      await h.timer.advanceTimeAsync(1);
      await pending.done;

      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();
      expect(h.manager.getSession("old")).toBeNull();
      expect(h.manager.getTerminalReleaseSnapshot("old")?.releaseReason).toBe("heartbeat-timeout");
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("release-persist-timeout")),
      ).toBe(true);
      expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
    } finally {
      warn.mockRestore();
    }
  });

  test("a release write that settles before the deadline behaves as before", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      const gate = Promise.withResolvers<void>();
      h.persistence.park = gate.promise;

      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS - 1);
      gate.resolve();
      await pending.done;

      expect(h.persistence.releaseWrites).toEqual(["old:heartbeat-timeout"]);
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();
      expect(h.manager.getTerminalReleaseSnapshot("old")?.releaseReason).toBe("heartbeat-timeout");
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("release-persist-timeout")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("the late write and a repeated release never free the next owner's device", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      const gate = Promise.withResolvers<void>();
      h.persistence.park = gate.promise;

      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);

      // The wedged write finally lands, and the reap is retried for the same session.
      gate.resolve();
      await flush();
      h.persistence.park = undefined;
      await releaseSessionAndDevice(h.manager, h.pool, device.deviceId, "old", "heartbeat-timeout");
      await flush();

      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("next");
      // The late write landed, and the repeated release retried the unconfirmed row.
      expect(h.persistence.releaseWrites).toEqual([
        "old:heartbeat-timeout",
        "old:heartbeat-timeout",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
