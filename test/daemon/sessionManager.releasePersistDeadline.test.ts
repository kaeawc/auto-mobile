import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
  TerminalSessionError,
} from "../../src/daemon/sessionManager";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { fixedBackoff } from "../../src/utils/Backoff";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
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
  /** While set, the next `markReleased` rejects with this after its park (SQLITE_BUSY). */
  failNextReleaseWrite: Error | undefined;
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
    const failure = this.failNextReleaseWrite;
    if (failure) {
      this.failNextReleaseWrite = undefined;
      throw failure;
    }
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

describe("a terminal release write that times out and then fails is retried (#10959)", () => {
  const RETRY_DELAY_MS = 1_000;

  /** Park the reap's write past its deadline, then let the parked write reject. */
  async function timeOutThenFail(h: Harness): Promise<void> {
    h.manager.setTerminalReleaseRetryBackoff(fixedBackoff(RETRY_DELAY_MS));
    const gate = Promise.withResolvers<void>();
    h.persistence.park = gate.promise;
    h.persistence.failNextReleaseWrite = new Error("SQLITE_BUSY: database is locked");
    const pending = reap(h);
    await flush();
    await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    await pending.done;
    h.persistence.park = undefined;
    gate.resolve();
    await flush();
    expect((await h.persistence.getSession!("old"))?.status).toBe("active");
  }

  /** A new daemon on the same database refuses the released UUID. */
  async function expectRefusedAfterRestart(h: Harness): Promise<void> {
    const restarted = new SessionManager(h.timer, h.persistence, () => new FakeDbWriteBarrier());
    managers.push(restarted);
    await expect(restarted.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
      TerminalSessionError,
    );
    await expect(
      restarted.getOrCreateSession("old", h.pool, "android", undefined, true),
    ).rejects.toBeInstanceOf(TerminalSessionError);
  }

  test("the failed late write is re-queued with the injected backoff and lands before a restart", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await timeOutThenFail(h);

      await h.timer.advanceTimeAsync(RETRY_DELAY_MS);
      await flush();

      expect(h.persistence.releaseWrites).toEqual(["old:heartbeat-timeout"]);
      expect((await h.persistence.getSession!("old"))?.status).not.toBe("active");
      await expectRefusedAfterRestart(h);
    } finally {
      warn.mockRestore();
    }
  });

  test("a retry that fails again is re-queued until it lands", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await timeOutThenFail(h);

      h.persistence.failNextReleaseWrite = new Error("SQLITE_BUSY: database is locked");
      await h.timer.advanceTimeAsync(RETRY_DELAY_MS);
      await flush();
      expect((await h.persistence.getSession!("old"))?.status).toBe("active");

      await h.timer.advanceTimeAsync(RETRY_DELAY_MS);
      await flush();
      expect(h.persistence.releaseWrites).toEqual(["old:heartbeat-timeout"]);
      await expectRefusedAfterRestart(h);
    } finally {
      warn.mockRestore();
    }
  });

  test("the shutdown drain writes a pending terminal row without waiting out the backoff", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await timeOutThenFail(h);

      expect(await h.manager.drainReleasePromises(5_000)).toBe(true);
      expect(h.persistence.releaseWrites).toEqual(["old:heartbeat-timeout"]);
      await expectRefusedAfterRestart(h);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a crash while a terminal release write is parked does not revive the UUID (#10959)", () => {
  const JOURNAL = "/data/terminal-release-intents.jsonl";

  async function journaledHarness() {
    const h = await harness();
    const files = new FakeTerminalReleaseJournalFileSystem();
    h.manager.attachTerminalReleaseJournal(new FileTerminalReleaseJournal(JOURNAL, files));
    return { ...h, files };
  }

  /** A new daemon process on the same database and data directory. */
  function restart(h: Harness, files: FakeTerminalReleaseJournalFileSystem): SessionManager {
    const restarted = new SessionManager(h.timer, h.persistence, () => new FakeDbWriteBarrier());
    managers.push(restarted);
    restarted.attachTerminalReleaseJournal(new FileTerminalReleaseJournal(JOURNAL, files));
    return restarted;
  }

  test("a crash after the intent, before the write lands, restarts with the UUID terminal", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await journaledHarness();
      h.persistence.park = new Promise<void>(() => {});
      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      // The daemon dies here: the write never lands and the row is still active.
      h.persistence.park = undefined;
      expect((await h.persistence.getSession!("old"))?.status).toBe("active");

      const restarted = restart(h, h.files);
      // Refused before rehydration has written anything.
      await expect(restarted.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
        TerminalSessionError,
      );
      await expect(
        restarted.getOrCreateSession("old", h.pool, "android", undefined, true),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();

      const summary = await restarted.rehydratePersistedSessions(h.pool);
      expect(summary.rehydrated).not.toContain("old");
      const row = await h.persistence.getSession!("old");
      expect(row?.status).not.toBe("active");
      expect(row?.release_reason).toBe("heartbeat-timeout");
      expect(h.files.files.has(JOURNAL)).toBe(false);

      // A third daemon refuses it from the row alone.
      const third = new SessionManager(h.timer, h.persistence, () => new FakeDbWriteBarrier());
      managers.push(third);
      await expect(third.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
        TerminalSessionError,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("the intent is written before the DB write and compacted once it lands", async () => {
    const h = await journaledHarness();
    let journalAtWrite: string | undefined;
    const markReleased = h.persistence.markReleased.bind(h.persistence);
    h.persistence.markReleased = async (...args) => {
      journalAtWrite = h.files.files.get(JOURNAL);
      await markReleased(...args);
    };

    await reap(h).done;

    expect(journalAtWrite).toContain('"sessionId":"old"');
    expect(h.files.appends).toHaveLength(1);
    expect(h.files.files.has(JOURNAL)).toBe(false);
  });

  test("a parked write that lands late compacts its intent", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await journaledHarness();
      const gate = Promise.withResolvers<void>();
      h.persistence.park = gate.promise;
      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      expect(h.files.files.has(JOURNAL)).toBe(true);

      h.persistence.park = undefined;
      gate.resolve();
      await flush();

      expect(h.files.files.has(JOURNAL)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a torn tail after the intent is ignored and the UUID is still refused", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await journaledHarness();
      h.persistence.park = new Promise<void>(() => {});
      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      h.persistence.park = undefined;
      // The crash tore a second append mid-line.
      h.files.files.set(JOURNAL, `${h.files.files.get(JOURNAL)}{"sessionId":"oth`);

      const restarted = restart(h, h.files);
      await expect(restarted.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
        TerminalSessionError,
      );
      await restarted.rehydratePersistedSessions(h.pool);
      expect((await h.persistence.getSession!("old"))?.release_reason).toBe("heartbeat-timeout");
      expect(h.files.files.has(JOURNAL)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("an intent whose row is already terminal is dropped without a second write", async () => {
    const h = await journaledHarness();
    await reap(h).done;
    h.files.files.set(
      JOURNAL,
      `${JSON.stringify({ sessionId: "old", reason: "explicit-release", at: 1 })}\n`,
    );
    const writes = h.persistence.releaseWrites.length;

    const restarted = restart(h, h.files);
    expect(await restarted.applyRecoveredTerminalReleaseIntents()).toEqual([]);

    expect(h.persistence.releaseWrites).toHaveLength(writes);
    expect((await h.persistence.getSession!("old"))?.release_reason).toBe("heartbeat-timeout");
    expect(h.files.files.has(JOURNAL)).toBe(false);
  });
});
