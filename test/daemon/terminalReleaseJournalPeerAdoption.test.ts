import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceOwnedByOtherDaemonError } from "../../src/daemon/deviceAcquisitionRefusals";
import {
  SessionManager,
  TerminalSessionError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import {
  createDaemonTerminalReleaseJournal,
  terminalReleaseJournalPath,
} from "../../src/daemon/terminalReleaseJournal";
import {
  deviceRestartReleaseReason,
  DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";

// #11355: a terminal release whose row write never landed lives only in the releasing daemon's
// journal. A daemon that started while that daemon was live skipped its journal at startup, so
// once the releasing daemon died the survivor saw a still-active row owned by a dead daemon and
// recovered the released session. The survivor adopts a dead owner's journal before it reads one
// of that owner's rows.

const DATA = "/data";
const IDLE_MS = 30 * 60_000;
const DEVICES = ["emulator-5554", "emulator-5556"] as const;
const STABLE_ID = "Pixel_8_API_35";

let db: Kysely<Database> | undefined;
const managers: SessionManager[] = [];

beforeAll(async () => {
  // Warm the migrated template outside the per-test budget.
  await (await createTestDatabase()).destroy();
});

afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.stopCleanupTimer());
  await db?.destroy();
  db = undefined;
});

/** One daemon's terminal-release writes: let through, parked behind a wedged writer, or failing. */
class ReleaseWriteGate {
  mode: "open" | "parked" | "failing" = "open";
  private readonly parked: Array<() => void> = [];

  /** Let every parked write reach the database, and wait for them to land. */
  async flush(): Promise<void> {
    this.mode = "open";
    const landed = this.parked.splice(0).map((run) => run());
    await Promise.all(landed);
  }

  wrap(repository: DeviceSessionRepository): DeviceSessionRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "markReleased" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: Parameters<DeviceSessionRepository["markReleased"]>) => {
          if (this.mode === "failing") {
            return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
          }
          if (this.mode === "open") {
            return target.markReleased(...args);
          }
          return new Promise<void>((resolve, reject) => {
            this.parked.push(() => target.markReleased(...args).then(resolve, reject));
          });
        };
      },
    });
  }
}

async function world() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  db = await createTestDatabase();
  const repository = new DeviceSessionRepository(db, timer);
  const files = new FakeTerminalReleaseJournalFileSystem();
  const live = new Set<string>();
  /** Start a daemon as daemon.ts does: listed live, then its journal adopts dead daemons' files. */
  const start = (daemonSessionId: string) => {
    const gate = new ReleaseWriteGate();
    const manager = new SessionManager(timer, gate.wrap(repository));
    managers.push(manager);
    manager.attachDaemonSessionId(daemonSessionId);
    manager.attachLiveDaemonSessionIds(() => new Set(live));
    const journal = createDaemonTerminalReleaseJournal({
      daemonSessionId,
      liveDaemonSessionIds: new Set(live),
      dataDir: DATA,
      fileSystem: files,
    });
    live.add(daemonSessionId);
    manager.attachTerminalReleaseJournal(journal);
    const name = (sessionId: string) =>
      refusal(manager.getOrCreateSession(sessionId, assigner(manager), "android"));
    return { manager, journal, gate, name };
  };
  /** Daemon A holds `s`, loses its device (a recoverable release), and B starts beside it. */
  const lostDeviceBesidePeer = async () => {
    const a = start("daemon-a");
    await a.manager.createSession("s", DEVICES[0], "android", IDLE_MS, undefined, STABLE_ID);
    await repository.markReleased(
      "s",
      "expired",
      timer.now(),
      deviceRestartReleaseReason(STABLE_ID),
    );
    // B starts while A is live: startup adoption leaves A's journal alone.
    return { a, b: start("daemon-b") };
  };
  /** As above, then A upgrades the release to a terminal one whose row write never lands, and dies. */
  const peerDiedWithParkedRelease = async () => {
    const daemons = await lostDeviceBesidePeer();
    const c = start("daemon-c");
    daemons.a.journal.record({ sessionId: "s", reason: "device-killed", at: timer.now() });
    live.delete("daemon-a");
    return { ...daemons, c };
  };
  return {
    timer,
    repository,
    files,
    live,
    start,
    lostDeviceBesidePeer,
    peerDiedWithParkedRelease,
  };
}

/** A pool that would hand a recovering daemon the session's device back. */
function assigner(manager: SessionManager): SessionDeviceAssigner {
  return {
    async assignDeviceToSession(id, _platform, target): Promise<string> {
      const session = await manager.createSession(
        id,
        DEVICES[0],
        "android",
        target?.liveness?.sessionTimeoutMs,
        target?.liveness?.heartbeatTimeoutMs,
        target?.stableDeviceId,
        target?.liveness,
        target?.initialOwnership,
      );
      return session.assignedDevice;
    },
  };
}

async function refusal(run: Promise<unknown>): Promise<unknown> {
  return await run.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("a survivor adopts a dead peer's terminal-release journal (#11355)", () => {
  test("a session the dead peer journaled as released is refused as terminal and its row written", async () => {
    const { timer, repository, files, live, lostDeviceBesidePeer } = await world();
    const { a, b } = await lostDeviceBesidePeer();
    // A upgrades the release to a terminal one, but that row write never lands; then A dies.
    timer.advanceTime(1_000);
    const releasedAt = timer.now();
    a.journal.record({ sessionId: "s", reason: "device-killed", at: releasedAt });
    live.delete("daemon-a");
    expect(await repository.getSession("s")).toMatchObject({
      release_reason: deviceRestartReleaseReason(STABLE_ID),
      daemon_session_id: "daemon-a",
    });

    timer.advanceTime(1_000);
    const error = await refusal(b.manager.getOrCreateSession("s", assigner(b.manager), "android"));

    expect(error).toBeInstanceOf(TerminalSessionError);
    expect((error as TerminalSessionError).release.releaseReason).toBe("device-killed");
    expect(b.manager.getSession("s")).toBeNull();
    // The row carries A's reason and release time, and nothing is left to adopt or confirm.
    expect(await repository.getSession("s")).toMatchObject({
      release_reason: "device-killed",
      released_at_ms: releasedAt,
      daemon_session_id: "daemon-a",
    });
    expect(files.files.has(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(false);
    expect(b.journal.loadUnconfirmed()).toEqual([]);
  });

  // Review of #11355: the dead daemon's file is the one copy every survivor can read, so it
  // stays until the terminal row is confirmed.
  test("a second survivor still refuses the session while the first survivor's write is parked", async () => {
    const { repository, files, peerDiedWithParkedRelease } = await world();
    const { b, c } = await peerDiedWithParkedRelease();
    b.gate.mode = "parked";
    const viaB = b.name("s");
    await Promise.resolve();

    expect(await c.name("s")).toBeInstanceOf(TerminalSessionError);
    expect(c.manager.getSession("s")).toBeNull();
    expect(await repository.getSession("s")).toMatchObject({
      release_reason: "device-killed",
      daemon_session_id: "daemon-a",
    });
    expect(files.files.has(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(false);

    await b.gate.flush();
    expect(await viaB).toBeInstanceOf(TerminalSessionError);
    expect((await repository.getSession("s"))?.release_reason).toBe("device-killed");
  });

  test("a parked adopted release never lands on a row another daemon took meanwhile", async () => {
    const { repository, peerDiedWithParkedRelease } = await world();
    const { b } = await peerDiedWithParkedRelease();
    b.gate.mode = "parked";
    const viaB = b.name("s");
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    // Another daemon takes the row over after B read it as the dead daemon's.
    const row = await repository.getSession("s");
    expect(
      await repository.claimRecoverableSession(
        "s",
        { rowGeneration: row?.stable_identity_generation ?? 0, daemonSessionId: "daemon-a" },
        "daemon-c",
      ),
    ).toBeDefined();

    await b.gate.flush();
    await viaB;

    expect(await repository.getSession("s")).toMatchObject({
      release_reason: deviceRestartReleaseReason(STABLE_ID),
      daemon_session_id: "daemon-c",
    });
  });

  test("a failed adopted write keeps the dead daemon's journal for the next survivor", async () => {
    const { repository, files, live, peerDiedWithParkedRelease } = await world();
    const { b, c } = await peerDiedWithParkedRelease();
    const journalText = files.files.get(terminalReleaseJournalPath(DATA, "daemon-a"));
    b.gate.mode = "failing";

    // B cannot write the row, but still refuses the session, and A's journal stays.
    expect(await b.name("s")).toBeInstanceOf(TerminalSessionError);
    expect((await repository.getSession("s"))?.release_reason).toBe(
      deviceRestartReleaseReason(STABLE_ID),
    );
    expect(files.files.get(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(journalText);

    live.delete("daemon-b");
    expect(await c.name("s")).toBeInstanceOf(TerminalSessionError);
    expect(c.manager.getSession("s")).toBeNull();
    expect((await repository.getSession("s"))?.release_reason).toBe("device-killed");
    expect(files.files.has(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(false);
  });

  test("a daemon started after the failed write still refuses the session once the adopter dies", async () => {
    const { repository, live, start, peerDiedWithParkedRelease } = await world();
    const { b } = await peerDiedWithParkedRelease();
    b.gate.mode = "failing";
    expect(await b.name("s")).toBeInstanceOf(TerminalSessionError);

    const successor = start("daemon-b2");
    live.delete("daemon-b");

    expect(await successor.name("s")).toBeInstanceOf(TerminalSessionError);
    expect(successor.manager.getSession("s")).toBeNull();
    expect((await repository.getSession("s"))?.release_reason).not.toBe("device-killed");
    await successor.manager.applyRecoveredTerminalReleaseIntents();
    expect((await repository.getSession("s"))?.release_reason).toBe("device-killed");
  });

  test("a failed adopted write is retried when a row of the dead daemon is next read", async () => {
    const { timer, repository, files, peerDiedWithParkedRelease } = await world();
    const { b } = await peerDiedWithParkedRelease();
    await repository.upsertActiveSession({
      sessionUuid: "u",
      deviceId: DEVICES[1],
      stableDeviceId: STABLE_ID,
      platform: "android",
      createdAtMs: timer.now(),
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + IDLE_MS,
      sessionTimeoutMs: IDLE_MS,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
      daemonSessionId: "daemon-a",
    });
    b.gate.mode = "failing";
    expect(await b.name("s")).toBeInstanceOf(TerminalSessionError);

    b.gate.mode = "open";
    await b.name("u");

    expect((await repository.getSession("s"))?.release_reason).toBe("device-killed");
    expect(files.files.has(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(false);
  });

  test("a live peer's journal is never read: its in-flight release may still be lifted", async () => {
    const { timer, repository, files, lostDeviceBesidePeer } = await world();
    const { a, b } = await lostDeviceBesidePeer();
    a.journal.record({ sessionId: "s", reason: "device-killed", at: timer.now() });
    const journalText = files.files.get(terminalReleaseJournalPath(DATA, "daemon-a"));

    const error = await refusal(b.manager.getOrCreateSession("s", assigner(b.manager), "android"));

    expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(files.files.get(terminalReleaseJournalPath(DATA, "daemon-a"))).toBe(journalText);
    expect((await repository.getSession("s"))?.release_reason).toBe(
      deviceRestartReleaseReason(STABLE_ID),
    );
    expect(b.journal.loadUnconfirmed()).toEqual([]);
  });

  test("a still-active row of the dead peer is terminalized, not left owned by a dead daemon", async () => {
    const { timer, repository, live, start } = await world();
    const a = start("daemon-a");
    await a.manager.createSession("s", DEVICES[0], "android", IDLE_MS);
    const b = start("daemon-b");
    a.journal.record({ sessionId: "s", reason: "explicit-release", at: timer.now() });
    live.delete("daemon-a");

    const error = await refusal(b.manager.getOrCreateSession("s", assigner(b.manager), "android"));

    expect(error).toBeInstanceOf(TerminalSessionError);
    expect(await repository.getSession("s")).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
  });

  test("an adopted intent never terminalizes a row another daemon took over", async () => {
    const { timer, repository, live, start } = await world();
    const a = start("daemon-a");
    await a.manager.createSession("s", DEVICES[0], "android", IDLE_MS);
    const b = start("daemon-b");
    // B holds t; A's journal carries a stale release of it from before B took it over.
    await b.manager.createSession("t", DEVICES[1], "android", IDLE_MS);
    a.journal.record({ sessionId: "t", reason: "device-killed", at: timer.now() });
    a.journal.record({ sessionId: "s", reason: "explicit-release", at: timer.now() });
    live.delete("daemon-a");

    const error = await refusal(b.manager.getOrCreateSession("s", assigner(b.manager), "android"));

    expect(error).toBeInstanceOf(TerminalSessionError);
    expect(b.manager.getSession("t")).not.toBeNull();
    expect(await repository.getSession("t")).toMatchObject({
      status: "active",
      release_reason: null,
      daemon_session_id: "daemon-b",
    });
    expect((await repository.getSession("s"))?.release_reason).toBe("explicit-release");
    expect(b.journal.loadUnconfirmed()).toEqual([]);
  });

  test("a dead peer with no journaled release leaves its recoverable row recoverable", async () => {
    const { repository, live, lostDeviceBesidePeer } = await world();
    const { b } = await lostDeviceBesidePeer();
    live.delete("daemon-a");

    const session = await b.manager.getOrCreateSession("s", assigner(b.manager), "android");

    expect(session.sessionId).toBe("s");
    expect(await repository.getSession("s")).toMatchObject({
      status: "active",
      daemon_session_id: "daemon-b",
    });
  });
});
