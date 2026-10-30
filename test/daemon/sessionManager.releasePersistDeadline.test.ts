import { NoopTerminalReleaseJournal } from "../../src/daemon/NoopTerminalReleaseJournal";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
import {
  DeviceSessionRowNotReleasableError,
  type MarkReleasedOptions,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { makeSessionManager, stopBuiltSessionManagers } from "../helpers/sessionManagerSuite";

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
  readonly releaseOptions: MarkReleasedOptions[] = [];
  readonly refusedWrites: unknown[] = [];
  readonly terminalizedGenerations: number[] = [];

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options: MarkReleasedOptions = {},
  ): Promise<void> {
    this.releaseOptions.push(options);
    await this.park;
    const failure = this.failNextReleaseWrite;
    if (failure) {
      this.failNextReleaseWrite = undefined;
      throw failure;
    }
    this.releaseWrites.push(`${sessionUuid}:${reason}`);
    try {
      await super.markReleased(sessionUuid, status, releasedAtMs, reason, options);
      this.terminalizedGenerations.push(
        (await this.getSession(sessionUuid))?.stable_identity_generation ?? 0,
      );
    } catch (error) {
      this.refusedWrites.push(error);
      throw error;
    }
  }

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ): Promise<number> {
    await this.parkCreate;
    return await super.upsertActiveSession(...args);
  }
}

afterEach(() => {
  stopBuiltSessionManagers();
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.reset();
});

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const persistence = new ParkableReleasePersistence();
  const manager = makeSessionManager({ timer: timer, persistence: persistence, fakeBarrier: true });
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
  await pool.bindOrReuseDeviceSession({
    sessionId: "old",
    deviceId: device.deviceId,
    platform: "android",
  });
  return { timer, manager, pool, persistence };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The heartbeat monitor's reap: a terminal release followed by the pool release. */
function reap(h: Harness): { done: Promise<void>; settled: () => boolean } {
  let settled = false;
  const done = releaseSessionAndDevice(h.manager, h.pool, device.deviceId, "old", {
    reason: "heartbeat-timeout",
  }).finally(() => {
    settled = true;
  });
  return { done, settled: () => settled };
}

beforeAll(async () => {
  // Warm release lifecycle modules outside the 15 ms per-test budget.
  const h = await harness();
  await reap(h).done;
  h.manager.stopCleanupTimer();
});

describe("a release whose DB write never settles is bounded by a deadline (#10836)", () => {
  test.each(["noop", "failed-file", "durable-file"])(
    "%s intent keeps row-first ordering and diagnoses crash safety at timeout",
    async (kind) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const h = await harness();
        if (kind !== "noop") {
          const files = new FakeTerminalReleaseJournalFileSystem();
          if (kind === "failed-file") {
            files.failNextAppend = new Error("ENOSPC");
          }
          h.manager.attachTerminalReleaseJournal(
            new FileTerminalReleaseJournal("/data/release.jsonl", files),
          );
        }
        h.persistence.park = new Promise<void>(() => {});
        const pending = reap(h);
        await flush();
        expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("old");
        await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
        await pending.done;
        expect((await h.persistence.getSession("old"))?.status).toBe("active");
        expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();
        expect(
          warn.mock.calls.some((call) =>
            String(call[0]).includes("no crash-safe intent (volatile)"),
          ),
        ).toBe(kind !== "durable-file");
      } finally {
        warn.mockRestore();
      }
    },
  );
  test("a volatile intent still warns when the deadline sees an upgraded snapshot copy", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      h.persistence.park = new Promise<void>(() => {});
      const pending = reap(h);
      await flush();
      const snapshot = h.manager.testHooks.wiring.host.sessionSlots.getTerminalSnapshot("old")!;
      // Reason reconciliation copies snapshots even when the winning reason stays the same.
      h.manager.testHooks.wiring.host.sessionSlots.setTerminalSnapshot(
        "old",
        h.manager["withReleaseReason"](snapshot, snapshot.releaseReason),
      );
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("no crash-safe intent (volatile)")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

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
      await releaseSessionAndDevice(h.manager, h.pool, device.deviceId, "old", {
        reason: "heartbeat-timeout",
      });
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
    const restarted = makeSessionManager({
      timer: h.timer,
      persistence: h.persistence,
      fakeBarrier: true,
    });
    await expect(restarted.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
      TerminalSessionError,
    );
    await expect(
      restarted.getOrCreateSession("old", h.pool, "android", { requireIssuedSession: true }),
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
    const restarted = makeSessionManager({
      timer: h.timer,
      persistence: h.persistence,
      fakeBarrier: true,
    });
    restarted.attachTerminalReleaseJournal(new FileTerminalReleaseJournal(JOURNAL, files));
    return restarted;
  }

  test.each([0, 1000])(
    "startup stale-row sweep before replay cannot revive a UUID (rehydration budget %i ms)",
    async (deadlineMs) => {
      const h = await journaledHarness();
      const intent = { sessionId: "old", reason: "heartbeat-timeout", at: h.timer.now() };
      new FileTerminalReleaseJournal(JOURNAL, h.files).record(intent);
      // Daemon.initializeDatabase's stale-active sweep precedes journal attachment in startOn.
      await h.persistence.markReleased("old", "expired", h.timer.now(), "daemon-restart");
      expect((await h.persistence.getSession("old"))?.release_reason).toBe("daemon-restart");
      const restarted = restart(h, h.files);
      const assign = spyOn(h.pool, "assignDeviceToSession");
      try {
        const summary = await restarted.rehydratePersistedSessions(h.pool, { deadlineMs });
        expect(summary.rehydrated).toEqual([]);
        expect(assign).not.toHaveBeenCalled();
        await expect(restarted.admitIssuedSessionForAutomation("old")).rejects.toBeInstanceOf(
          TerminalSessionError,
        );
        expect((await h.persistence.getSession("old"))?.release_reason).toBe(
          deadlineMs === 0 ? "daemon-restart" : "heartbeat-timeout",
        );
        expect(h.files.files.has(JOURNAL)).toBe(deadlineMs === 0);
        // The deadlineAt break leaves the intent fenced and available for the next startup.
        expect(await restarted.applyRecoveredTerminalReleaseIntents()).toEqual(
          deadlineMs === 0 ? ["old"] : [],
        );
        expect((await h.persistence.getSession("old"))?.release_reason).toBe("heartbeat-timeout");
        expect(h.files.files.has(JOURNAL)).toBe(false);
      } finally {
        assign.mockRestore();
      }
    },
  );

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
        restarted.getOrCreateSession("old", h.pool, "android", { requireIssuedSession: true }),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();

      const summary = await restarted.rehydratePersistedSessions(h.pool);
      expect(summary.rehydrated).not.toContain("old");
      const row = await h.persistence.getSession!("old");
      expect(row?.status).not.toBe("active");
      expect(row?.release_reason).toBe("heartbeat-timeout");
      expect(h.files.files.has(JOURNAL)).toBe(false);

      // A third daemon refuses it from the row alone.
      const third = makeSessionManager({
        timer: h.timer,
        persistence: h.persistence,
        fakeBarrier: true,
      });
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

  test("a pending recovered intent reads as the release reason before its row is written (#11077)", async () => {
    const h = await journaledHarness();
    h.files.files.set(
      JOURNAL,
      `${JSON.stringify({ sessionId: "old", reason: "heartbeat-timeout", at: 1 })}\n`,
    );
    const restarted = restart(h, h.files);

    expect(await restarted.getReleasedSessionReason("old")).toBe("heartbeat-timeout");
    expect(await restarted.getReleasedSessionReason("never-issued")).toBeUndefined();
  });
});

describe("a superseded device-loss release leaves the live session's row active (#11206)", () => {
  test("a late terminal generation miss preserves a different Session recreated by the same manager", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      const files = new FakeTerminalReleaseJournalFileSystem();
      h.manager.attachTerminalReleaseJournal(
        new FileTerminalReleaseJournal("/data/generation.jsonl", files),
      );
      const originalGeneration = (await h.persistence.getSession("old"))!
        .stable_identity_generation;
      const gate = Promise.withResolvers<void>();
      h.persistence.park = gate.promise;
      // A durable intent commits the release before its row lands: the device is freed, the
      // statement stays parked, and the lifted fence permits a new incarnation (#11799).
      const release = h.manager.releaseSessionUnlessSuperseded(
        "old",
        `device-disconnected:${device.deviceId}`,
        { commitFence: () => true },
      );
      await flush();
      const snapshot = h.manager.testHooks.wiring.host.sessionSlots.getTerminalSnapshot("old")!;
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await expect(release).resolves.toEqual({ superseded: false, deviceId: device.deviceId });
      // #12515: a different Session's upsert must stay protected even when this same daemon
      // owned the old release.
      h.persistence.park = undefined;
      const lift = Reflect.get(h.manager, "liftTerminalFence") as (uuid: string) => void;
      lift.call(h.manager, "old");
      await h.manager.createSession("old", device.deviceId, "android");
      const generation = (await h.persistence.getSession("old"))!.stable_identity_generation!;
      expect(generation).toBeGreaterThan(originalGeneration!);
      expect(h.manager.getTerminalReleaseSnapshot("old")).toBeUndefined();
      expect(files.files.size).toBe(0);
      h.persistence.park = undefined;
      gate.resolve();
      await flush();
      expect(h.persistence.terminalizedGenerations).not.toContain(generation);
      expect(h.persistence.releaseOptions[0].expectedRowGeneration).toBe(originalGeneration);
      // Even a recoverable row cannot substitute its new generation while this UUID is held.
      const liveRow = { ...(await h.persistence.getSession("old"))! };
      h.persistence.seed({ ...liveRow, status: "expired", release_reason: "daemon-restart" });
      expect(
        (await h.manager["retriedReleaseWritePrecondition"](snapshot)).expectedRowGeneration,
      ).toBe(originalGeneration);
      h.persistence.seed(liveRow);
      expect(h.persistence.refusedWrites).toHaveLength(1);
      expect(h.persistence.refusedWrites[0]).toBeInstanceOf(DeviceSessionRowNotReleasableError);
      expect((await h.persistence.getSession("old"))?.status).toBe("active");
      expect((await h.persistence.getSession("old"))?.stable_identity_generation).toBe(generation);
      expect(await h.manager.drainReleasePromises(5_000)).toBe(true);
      await h.timer.advanceTimeAsync(10_000);
      await flush();
      expect(h.persistence.releaseWrites).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a generation refusal before the deadline resolves the journal without throwing or retrying", async () => {
    const h = await harness();
    const files = new FakeTerminalReleaseJournalFileSystem();
    h.manager.attachTerminalReleaseJournal(
      new FileTerminalReleaseJournal("/data/refusal.jsonl", files),
    );
    const gate = Promise.withResolvers<void>();
    h.persistence.park = gate.promise;
    const pending = reap(h);
    await flush();
    const row = (await h.persistence.getSession("old"))!;
    // Model a generation advancing after statement issue, before the injected writer executes.
    h.persistence.seed({ ...row, stable_identity_generation: row.stable_identity_generation! + 1 });
    h.persistence.park = undefined;
    gate.resolve();
    await pending.done;
    expect(h.persistence.refusedWrites[0]).toBeInstanceOf(DeviceSessionRowNotReleasableError);
    expect((await h.persistence.getSession("old"))?.status).toBe("active");
    expect(files.files.size).toBe(0);
    expect(await h.manager.drainReleasePromises(5_000)).toBe(true);
    await h.timer.advanceTimeAsync(10_000);
    await flush();
    expect(h.persistence.releaseWrites).toHaveLength(1);
  });

  test("an unheld recoverable row still substitutes its hand-back generation for a terminal retry", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      h.persistence.park = new Promise<void>(() => {});
      const pending = reap(h);
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await pending.done;
      const snapshot = h.manager.testHooks.wiring.host.sessionSlots.getTerminalSnapshot("old")!;
      const row = (await h.persistence.getSession("old"))!;
      const handedBackGeneration = row.stable_identity_generation! + 2;
      h.persistence.seed({
        ...row,
        stable_identity_generation: handedBackGeneration,
        status: "expired",
        release_reason: "daemon-restart",
      });
      expect(
        (await h.manager["retriedReleaseWritePrecondition"](snapshot)).expectedRowGeneration,
      ).toBe(handedBackGeneration);
    } finally {
      warn.mockRestore();
    }
  });
  /** A new daemon process on the same database rehydrates the session the client still holds. */
  async function expectRehydratedAfterRestart(h: Harness): Promise<void> {
    // The next daemon's startup sweep retires only rows still active, as daemon-restart.
    if ((await h.persistence.getSession!("old"))?.status === "active") {
      await h.persistence.markReleased("old", "expired", h.timer.now(), "daemon-restart");
    }
    const restarted = makeSessionManager({
      timer: h.timer,
      persistence: h.persistence,
      fakeBarrier: true,
    });
    const summary = await restarted.rehydratePersistedSessions({
      assignDeviceToSession: async (sessionId) => {
        await restarted.createSession(sessionId, device.deviceId, "android");
        return device.deviceId;
      },
    });
    expect(summary.rehydrated).toEqual(["old"]);
  }

  test("a newer identity confirmation before the release commits leaves the row live", async () => {
    const h = await harness();
    const release = h.manager.releaseSessionUnlessSuperseded(
      "old",
      `device-disconnected:${device.deviceId}`,
      { commitFence: () => false },
    );
    await expect(release).resolves.toEqual({ superseded: true });
    expect(h.manager.getSession("old")).not.toBeNull();

    const row = await h.persistence.getSession!("old");
    expect(row?.status).toBe("active");
    expect(row?.release_reason).toBeNull();
    await expectRehydratedAfterRestart(h);
  });

  // #11799 W5: no fence is evaluated once the row statement is issued (volatile) or the commit
  // has passed (durable). Such a release has won; the identity confirmation arrives too late to undo it.
  test.each(["durable", "volatile"] as const)(
    "a slow %s terminal write overtaken by a newer identity confirmation has already won",
    async (intent) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const h = await harness();
        if (intent === "volatile") {
          h.manager.attachTerminalReleaseJournal(new NoopTerminalReleaseJournal());
        }
        let releaseWrite!: () => void;
        h.persistence.park = new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        let superseded = false;
        const release = h.manager.releaseSessionUnlessSuperseded(
          "old",
          `device-disconnected:${device.deviceId}`,
          { commitFence: () => !superseded },
        );
        await flush();
        // The serial is re-observed with a newer identity while the terminal write is in flight.
        superseded = true;
        await h.timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
        await expect(release).resolves.toEqual({ superseded: false, deviceId: device.deviceId });
        expect(h.manager.getSession("old")).toBeNull();

        h.persistence.park = undefined;
        releaseWrite();
        await flush();
        const row = await h.persistence.getSession!("old");
        expect(row?.status).not.toBe("active");
        expect(row?.release_reason).toBe(`device-disconnected:${device.deviceId}`);
        // The next daemon does not revive a session whose terminal row landed.
        const restarted = makeSessionManager({
          timer: h.timer,
          persistence: h.persistence,
          fakeBarrier: true,
        });
        const summary = await restarted.rehydratePersistedSessions({
          assignDeviceToSession: async () => device.deviceId,
        });
        expect(summary.rehydrated).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
  );
});
