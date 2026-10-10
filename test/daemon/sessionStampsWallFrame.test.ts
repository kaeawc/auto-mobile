import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import type {
  TerminalReleaseIntent,
  TerminalReleaseJournal,
} from "../../src/daemon/terminalReleaseJournal";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// #11162 item 5: a session stamp is on the writing daemon's session clock in memory, but the row
// (and the terminal-release journal) is read by another process on ITS session clock. Stamps are
// persisted as wall epoch ms and converted onto the reader's session clock on load, so a wall step
// one daemon lived through does not shift the stamps another daemon reads.

const HOUR_MS = 3_600_000;
const IDLE_MS = 30 * 60_000;
const DEVICE = "emulator-5554";

class RecordingJournal implements TerminalReleaseJournal {
  readonly recorded: TerminalReleaseIntent[] = [];
  constructor(private readonly unconfirmed: TerminalReleaseIntent[] = []) {}
  loadUnconfirmed(): TerminalReleaseIntent[] {
    return this.unconfirmed;
  }
  record(intent: TerminalReleaseIntent): void {
    this.recorded.push(intent);
  }
  resolve(): void {}
}

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
  const daemon = () => {
    const manager = new SessionManager(timer, repository);
    managers.push(manager);
    manager.sessionNow(); // the daemon's session clock starts with the process
    return manager;
  };
  return { timer, repository, daemon };
}

/** A pool that hands the rehydrating daemon its device back. */
function assigner(manager: SessionManager): SessionDeviceAssigner {
  return {
    async assignDeviceToSession(id, _platform, target): Promise<string> {
      const session = await manager.createSession(
        id,
        DEVICE,
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

describe("persisted session stamps cross daemons as wall epoch ms (#11162)", () => {
  test("a daemon whose session clock a backward wall step left ahead writes wall stamps", async () => {
    const { timer, repository, daemon } = await world();
    const writer = daemon();
    timer.stepWallClock(-HOUR_MS);
    expect(writer.sessionNow() - timer.now()).toBe(HOUR_MS);

    await writer.createSession("s", DEVICE, "android", IDLE_MS);
    const active = await repository.getSession("s");
    expect(active).toMatchObject({
      created_at_ms: timer.now(),
      last_used_at_ms: timer.now(),
      expires_at_ms: timer.now() + IDLE_MS,
    });

    const journal = new RecordingJournal();
    writer.attachTerminalReleaseJournal(journal);
    timer.advanceTime(1_000);
    await writer.releaseSession("s", "explicit-release");

    expect((await repository.getSession("s"))?.released_at_ms).toBe(timer.now());
    expect(journal.recorded.map((intent) => intent.at)).toEqual([timer.now()]);
  });

  test("a daemon whose session clock runs ahead of the wall clock reads a wall-stamped row in its own frame", async () => {
    const { timer, repository, daemon } = await world();
    const reader = daemon();
    timer.stepWallClock(-HOUR_MS);
    // Another process (a peer daemon, or one from before this change) leaves a recoverable row
    // stamped in wall ms after the step.
    await repository.upsertActiveSession({
      sessionUuid: "s",
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      createdAtMs: timer.now(),
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + IDLE_MS,
      sessionTimeoutMs: IDLE_MS,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    await repository.markReleased("s", "expired", timer.now(), "daemon-restart");

    timer.advanceTime(60_000);
    const summary = await reader.rehydratePersistedSessions(assigner(reader));

    // Read in the reader's frame the row would look an hour older and already expired.
    expect(summary.rehydrated).toEqual(["s"]);
    expect(reader.getSession("s")).not.toBeNull();
  });

  // Pins that the journal's load and write conversions compose: converting only one side moves
  // the recovered release by the reader's offset from the wall clock.
  test("an unconfirmed terminal release is written back at the instant its journal recorded", async () => {
    const { timer, repository, daemon } = await world();
    await repository.upsertActiveSession({
      sessionUuid: "s",
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      createdAtMs: timer.now(),
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + IDLE_MS,
      sessionTimeoutMs: IDLE_MS,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    const releasedAt = timer.now();

    const reader = daemon();
    timer.stepWallClock(-HOUR_MS);
    reader.attachTerminalReleaseJournal(
      new RecordingJournal([{ sessionId: "s", reason: "explicit-release", at: releasedAt }]),
    );
    expect(await reader.applyRecoveredTerminalReleaseIntents()).toEqual(["s"]);

    expect(await repository.getSession("s")).toMatchObject({
      release_reason: "explicit-release",
      released_at_ms: releasedAt,
    });
  });
});
