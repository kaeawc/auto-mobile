import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  SessionManager,
  TerminalSessionError,
  UnissuedSessionError,
} from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// #11361 item 1: a row whose deadline passed while its daemon was down names a session that is
// gone for good. A call naming it is told so with the typed terminal refusal (carrying the
// `expired` reason), not the untyped "not found" a typo gets. The row itself stays non-terminal.

const SESSION = "s1";
const DEVICE = "emulator-5554";
const DEADLINE = 61_000;

describe("a session whose row expired while the daemon was down (#11361)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository(db, timer);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** A row the previous daemon left behind, released with `reason` when one is given. */
  async function seedRow(reason?: string): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "dead-daemon",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: DEADLINE,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    if (reason) {
      await repo.markReleased(SESSION, "released", 1_000, reason);
    }
  }

  /** The daemon that starts after the previous one died. */
  function restartedDaemon(): SessionManager {
    const manager = new SessionManager(timer, repo);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-b");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-b"]));
    return manager;
  }

  async function refusal(manager: SessionManager, access?: "read-only"): Promise<unknown> {
    return await manager
      .admitIssuedSessionForAutomation(SESSION, undefined, access ? { access } : {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  }

  for (const [label, reason] of [
    ["a live row whose idle deadline passed", undefined],
    ["a daemon-shutdown handoff whose recovery window lapsed", "daemon-shutdown"],
    ["a device-restart handoff whose recovery window lapsed", `device-restart:${DEVICE}`],
  ] as const) {
    test(`${label} answers the typed terminal refusal with reason expired`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      const manager = restartedDaemon();

      const error = await refusal(manager);
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect((error as TerminalSessionError).release).toMatchObject({
        sessionId: SESSION,
        deviceId: DEVICE,
        releaseReason: "expired",
        terminal: true,
      });
      // Row hygiene is unchanged: the answer writes no terminal reason to the row.
      expect((await repo.getSession(SESSION))?.release_reason ?? undefined).toBe(reason);

      // A read is never refused: it gets the answer its caller turns into a sessionless read.
      expect(await refusal(manager, "read-only")).toBeInstanceOf(UnissuedSessionError);
    });
  }

  test("a row the startup sweep already marked expired answers the same refusal", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE + 1);
    await repo.listRecoverableSessions(timer.now());
    expect((await repo.getSession(SESSION))?.release_reason).toBe("expired");

    const error = await refusal(restartedDaemon());
    expect(error).toBeInstanceOf(TerminalSessionError);
    expect((error as TerminalSessionError).release.releaseReason).toBe("expired");
  });

  test("the device-tool path marks the row expired and answers the same refusal", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE + 1);
    const manager = restartedDaemon();
    const assigned: string[] = [];
    const pool = {
      async assignDeviceToSession(id: string): Promise<string> {
        assigned.push(id);
        return DEVICE;
      },
    };

    const error = await manager
      .getOrCreateSession(SESSION, pool, "android", undefined, true)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalSessionError);
    expect((error as TerminalSessionError).release.releaseReason).toBe("expired");
    // No device is assigned to the expired name, and the row keeps the non-terminal reason.
    expect(assigned).toEqual([]);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "expired",
    });
  });

  test("the expired answer raises no in-memory fence, so the name can be issued again", async () => {
    await seedRow();
    timer.setCurrentTime(DEADLINE + 1);
    const manager = restartedDaemon();

    expect(await refusal(manager)).toBeInstanceOf(TerminalSessionError);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    const created = await manager.createSession(SESSION, DEVICE, "android");
    expect(created.assignedDevice).toBe(DEVICE);
  });

  test("a recoverable handoff inside its window is still recovered, not refused", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE - 1);

    // Read-only admission never recovers; it reports the row as admissible by resolving.
    expect(await refusal(restartedDaemon(), "read-only")).toBeUndefined();
  });

  test("a never-issued id keeps the untyped not-found answer", async () => {
    const error = await refusal(restartedDaemon());
    expect(error).toBeInstanceOf(UnissuedSessionError);
    expect((error as Error).message).toContain("not an active daemon session (not found)");
  });
});
