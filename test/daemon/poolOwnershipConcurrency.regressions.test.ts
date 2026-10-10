import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { PLAN_AUTO_RELEASE_REASON, SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntil, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

// Minimized regressions for the ownership races the seeded concurrency harness
// (test/helpers/poolOwnershipConcurrencyHarness.ts) found (#11146). Each failed before its fix; a
// newly found race lands here as a `test.todo` with its violation kind tolerated in
// poolOwnershipConcurrency.property.test.ts until it is fixed.

const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };

interface PoolWorld {
  timer: FakeTimer;
  manager: SessionManager;
  pool: DevicePool;
  releases: Array<{ sessionId: string; reason: string; upgradeOnly: boolean }>;
  /** Every autolock owner row write, in order. */
  autolockRows: Array<{ sessionId: string; mcpSessionId: string | null | undefined }>;
  /** Awaited inside every autolock owner row write, so a test can close a connection mid-write. */
  autolockRowGate: { wait?: () => Promise<void> };
}

const worlds: PoolWorld[] = [];

async function createPoolWorld(): Promise<PoolWorld> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const releases: PoolWorld["releases"] = [];
  manager.onSessionRelease((sessionId, _deviceId, reason, _snapshot, options) => {
    releases.push({ sessionId, reason, upgradeOnly: options?.upgradeOnly === true });
  });
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE];
  const autolockRows: PoolWorld["autolockRows"] = [];
  const autolockRowGate: PoolWorld["autolockRowGate"] = {};
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "ownership-regression-daemon", {
      timer,
      deviceManager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceSessionRepository: {
        markAutolockSession: async (sessionId, input) => {
          await autolockRowGate.wait?.();
          autolockRows.push({ sessionId, mcpSessionId: input.mcpSessionId });
        },
      },
    }),
  );
  await pool.initializeWithDevices([DEVICE]);
  const world = { timer, manager, pool, releases, autolockRows, autolockRowGate };
  worlds.push(world);
  return world;
}

function bindForConnection(pool: DevicePool, sessionId: string, connection: string) {
  return pool.bindOrReuseDeviceSession(
    sessionId,
    DEVICE.deviceId,
    "android",
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    connection,
  );
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.manager.stopCleanupTimer();
  }
});

describe("pool ownership races found by the seeded concurrency harness", () => {
  // Harness: any seed of the default profile, e.g. AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE=4, shrinks
  // to two steps: `acquireMcp c3 d2` then `closeConnection c3` before the bind returns.
  //
  // Root cause (fixed, #11146): DevicePool.bindOrReuseDeviceSession recorded the caller's MCP
  // connection as the session's owner right after `await this.createSessionOrRestore(...)` without
  // checking the connection was still open. A close in that window had already run
  // releaseMcpSessionBindings(connection), so the dead connection stayed an owner forever. The pool
  // now tracks binds in flight per connection and skips the ownership record for one that closed.
  test("a connection that closed while its bind was in flight owns nothing", async () => {
    const { pool } = await createPoolWorld();

    const bind = bindForConnection(pool, "owner-session", "closing-connection");
    pool.releaseMcpSessionBindings("closing-connection");
    await bind;

    expect(pool.resolveOwnedDeviceSessionForMcpSession("closing-connection", DEVICE.deviceId)).toBe(
      undefined,
    );
  });

  // Consequence of the same race: the stale owner entry of the dead connection keeps
  // hasConnectedMcpSessionOwner() true for the session forever, so when the owner's proxy later
  // reconnects, restores the session and disconnects again, the owner-disconnect release (#10503)
  // is never armed and the device stays held until some other path (heartbeat lapse) frees it.
  test("an owner whose first connection closed mid-bind still gets the owner-disconnect release", async () => {
    const { pool, timer, manager, releases } = await createPoolWorld();

    const bind = bindForConnection(pool, "owner-session", "first-connection");
    pool.releaseMcpSessionBindings("first-connection");
    await bind;
    await pool.restoreOwnedDeviceSessionsForMcpSession(["owner-session"], "second-connection");
    pool.releaseMcpSessionBindings("second-connection");

    timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(manager.getSession("owner-session")).toBeNull();
    expect(releases.map((r) => r.reason)).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  // Root cause (fixed, #11166): the autolock acquisition path published its routes and acquired
  // set for the calling connection after awaits without checking it was still open (the same race
  // as the explicit bind above). It now goes through the pool's in-flight bind tracking.
  function autolockForConnection(pool: DevicePool, connection: string) {
    return pool.autolockDevice(
      DEVICE.deviceId,
      "android",
      connection,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "automationReady",
      undefined,
      { autolockEnabled: true },
    );
  }

  test("a connection that closed while its autolock acquisition was in flight owns nothing", async () => {
    const { pool } = await createPoolWorld();

    const acquire = autolockForConnection(pool, "closing-connection");
    pool.releaseMcpSessionBindings("closing-connection");
    const sessionId = await acquire;

    expect(sessionId).toBeDefined();
    expect(pool.resolveAutolockSessionForMcpSession("closing-connection")).toBeUndefined();
    expect(pool.hasConnectedMcpSessionOwner(sessionId!)).toBe(false);
  });

  test("an autolock acquired by a connection that closed mid-acquire is released on owner disconnect", async () => {
    const { pool, timer, manager, releases } = await createPoolWorld();

    const acquire = autolockForConnection(pool, "first-connection");
    pool.releaseMcpSessionBindings("first-connection");
    const sessionId = (await acquire)!;
    await pool.restoreOwnedDeviceSessionsForMcpSession([sessionId], "second-connection");
    pool.releaseMcpSessionBindings("second-connection");

    timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(manager.getSession(sessionId)).toBeNull();
    expect(releases.map((r) => r.reason)).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  // Root cause (fixed, #11192): the autolock attach paths (an explicit-UUID tool call, a
  // setActiveDevice selection, a reconnect restore) were not tracked as binds in flight and
  // published the caller's route, acquired set and pool ownership after awaiting the assignment
  // lock and the owner-row write, ignoring recordBindOwnership's refusal. A connection that closed
  // in that window became a dead owner, cancelling the owner-disconnect release (#10503).
  const ATTACH_PATHS: Array<
    [string, (pool: DevicePool, id: string, c: string) => Promise<unknown>]
  > = [
    ["explicit sessionUuid call", (pool, id, c) => pool.attachExplicitSessionUuidCall(id, c)],
    [
      "setActiveDevice selection",
      (pool, id, c) => pool.attachAutolockSessionToMcpSession(id, c, true, true),
    ],
    ["reconnect restore", (pool, id, c) => pool.restoreAutolockSessionsForMcpSession([id], c)],
  ];

  async function ownerlessAutolock(world: PoolWorld): Promise<string> {
    const sessionId = (await autolockForConnection(world.pool, "first-connection"))!;
    world.pool.releaseMcpSessionBindings("first-connection");
    return sessionId;
  }

  test.each(ATTACH_PATHS)(
    "a connection that closed while its autolock attach (%s) was in flight owns nothing",
    async (_path, attach) => {
      const world = await createPoolWorld();
      const sessionId = await ownerlessAutolock(world);

      const attaching = attach(world.pool, sessionId, "closing-connection");
      world.pool.releaseMcpSessionBindings("closing-connection");
      const outcome = await attaching;

      if (outcome !== undefined) {
        expect(outcome).toBe("not-attached");
      }
      expect(world.pool.resolveAutolockSessionForMcpSession("closing-connection")).toBeUndefined();
      expect(world.pool.hasConnectedMcpSessionOwner(sessionId)).toBe(false);
      world.timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
      expect(world.manager.getSession(sessionId)).toBeNull();
      expect(world.releases.map((r) => r.reason)).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    },
  );

  // Root cause (fixed, #11192): the attach wrote the owner row (markAutolockSession) before the
  // ownership decision, and an acquisition persisted its caller even when recordBindOwnership
  // refused it, so a daemon restart could restore a mapping to a connection that had closed.
  test.each(ATTACH_PATHS)(
    "a refused attach (%s) never persists the closed connection as owner",
    async (_path, attach) => {
      const world = await createPoolWorld();
      const sessionId = await ownerlessAutolock(world);

      const attaching = attach(world.pool, sessionId, "closing-connection");
      world.pool.releaseMcpSessionBindings("closing-connection");
      await attaching;

      expect(world.autolockRows.map((row) => row.mcpSessionId)).not.toContain("closing-connection");
    },
  );

  test("an acquisition refused as owner persists no owner row for the closed connection", async () => {
    const world = await createPoolWorld();

    const acquire = autolockForConnection(world.pool, "closing-connection");
    world.pool.releaseMcpSessionBindings("closing-connection");
    const sessionId = await acquire;

    expect(world.autolockRows).toEqual([{ sessionId: sessionId!, mcpSessionId: null }]);
  });

  test("a connection that closed while its attach wrote the owner row owns nothing", async () => {
    const world = await createPoolWorld();
    const sessionId = await ownerlessAutolock(world);
    const writing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    world.autolockRowGate.wait = async () => {
      writing.resolve();
      await proceed.promise;
    };

    const attaching = world.pool.attachExplicitSessionUuidCall(sessionId, "closing-connection");
    await writing.promise;
    world.pool.releaseMcpSessionBindings("closing-connection");
    proceed.resolve();
    await attaching;

    expect(world.pool.resolveAutolockSessionForMcpSession("closing-connection")).toBeUndefined();
    expect(world.pool.hasConnectedMcpSessionOwner(sessionId)).toBe(false);
  });

  // Harness: contention profile, AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE=1375 (before the disconnect
  // reason was made terminal) shrank to `acquireMcp c0 d0`, `kill d0`, `disconnect d0`; with the
  // real terminal device-loss reason the same class still shows as `plan-auto-release` or
  // `lazy-expiry` followed by `device-killed` (contention/releaseRace profiles).
  //
  // Root cause (fixed, #11146): SessionManager.releaseSessionInternal notifies onSessionRelease
  // when it commits the removal, then awaits completeReleasePersistence. A terminal release
  // (explicit-release, device-killed, ...) arriving in that await upgrades the shared reason, and
  // the second notification re-sent the caller's options without `upgradeOnly`, so every listener
  // (daemon.ts's central release cleanup, recording and performance-monitor cleanup, the pool's own
  // release handler) re-ran its full release cleanup. It now announces `{ upgradeOnly: true }`,
  // like releaseFinalizedSession's upgrade path (#10825).
  test("a terminal release racing a non-terminal one's persistence notifies a full release once", async () => {
    for (const first of [PLAN_AUTO_RELEASE_REASON, "lazy-expiry"]) {
      const timer = new FakeTimer();
      const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const full: string[] = [];
      manager.onSessionRelease((_id, _deviceId, reason, _snapshot, options) => {
        if (!options?.upgradeOnly) {
          full.push(reason);
        }
      });
      const session = await manager.createSession("s1", DEVICE.deviceId, "android");

      const nonTerminal = manager.releaseSession("s1", first);
      await drainUntil(() => full.length > 0, { description: "the first release notification" });
      const terminal = manager.releaseSessionIfOwned(
        "s1",
        session,
        DEVICE.deviceId,
        "device-killed",
      );
      await Promise.all([nonTerminal, terminal]);
      manager.stopCleanupTimer();

      expect(full).toEqual([first]);
    }
  });
});
