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

async function world() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  db = await createTestDatabase();
  const repository = new DeviceSessionRepository(db, timer);
  const files = new FakeTerminalReleaseJournalFileSystem();
  const live = new Set<string>();
  /** Start a daemon as daemon.ts does: listed live, then its journal adopts dead daemons' files. */
  const start = (daemonSessionId: string) => {
    const manager = new SessionManager(timer, repository);
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
    return { manager, journal };
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
  return { timer, repository, files, live, start, lostDeviceBesidePeer };
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
