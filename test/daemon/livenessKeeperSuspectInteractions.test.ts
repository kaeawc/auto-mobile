import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { CLI_KEEPER_LIVENESS_OWNER_KIND } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DAEMON_LIVENESS_OWNER_IS_PROXY_CODE } from "../../src/daemon/types";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10049 integration of #10051 (suspect grace window) and #10054 (the CLI heartbeat keeper is
// refused on a proxy-owned session): neither branch alone covers the keeper meeting a session
// whose proxy lease has lapsed. The handler, session manager and monitor are the real ones on a
// fake timer.

const SESSION = "proxy-owned-session";
const DEVICE = "emulator-5554";
const PROXY_TOKEN = "harness-proxy-token";
const KEEPER_TOKEN = "keeper-token";
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

describe("CLI keeper against a proxy-owned session whose lease lapsed (#10051 x #10054)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: Array<{ sessionId: string; reason: string }>;
  let monitor: SessionHeartbeatMonitor;

  function state(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => DEVICE_POOL,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  function heartbeat(params: Record<string, unknown>) {
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: SESSION, ...params },
      },
      state(),
    );
  }

  const keeper = (extra: Record<string, unknown> = {}) =>
    heartbeat({
      livenessPolicy: "heartbeat",
      livenessOwnerToken: KEEPER_TOKEN,
      livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
      ...extra,
    });

  /** The fields a refused keeper heartbeat must leave untouched. */
  function livenessSnapshot() {
    const session = sessionManager.getSession(SESSION)!;
    return {
      lastHeartbeat: session.lastHeartbeat,
      expiresAt: session.expiresAt,
      livenessPolicy: session.livenessPolicy,
      livenessOwnerToken: session.livenessOwnerToken,
      lease: sessionManager.getSessionLeaseState(SESSION),
    };
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    const claim = await heartbeat({
      livenessPolicy: "heartbeat",
      livenessOwnerToken: PROXY_TOKEN,
      claimLivenessOwnership: true,
    });
    expect(claim.success).toBe(true);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  test("a keeper is still refused on a SUSPECT proxy-owned session and changes nothing", async () => {
    timer.advanceTime(LEASE_MS + 2_000);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    const before = livenessSnapshot();

    for (const extra of [{}, { claimLivenessOwnership: true }]) {
      const refused = await keeper(extra);
      expect(refused).toMatchObject({ success: false, code: DAEMON_LIVENESS_OWNER_IS_PROXY_CODE });
    }

    expect(livenessSnapshot()).toEqual(before);
    expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
      phase: "suspect",
      remainingMs: SUSPECT_GRACE_MS - 2_000,
    });

    // The refusal did not stand in the owner's way: its own heartbeat restores the same UUID.
    const restored = await heartbeat({ livenessOwnerToken: PROXY_TOKEN });
    expect(restored.success).toBe(true);
    expect(sessionManager.getSession(SESSION)?.sessionId).toBe(SESSION);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
  });

  test("a keeper does not extend a session whose proxy lease and grace have lapsed", async () => {
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)).toEqual({
      phase: "lapsed",
      remainingMs: 0,
    });
    const before = livenessSnapshot();

    const refused = await keeper();
    expect(refused).toMatchObject({ success: false, code: DAEMON_LIVENESS_OWNER_IS_PROXY_CODE });
    expect(livenessSnapshot()).toEqual(before);

    // Nothing the keeper sent saved the session: the reaper still releases it for the lapse.
    await monitor.tick();
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    expect(sessionManager.getSession(SESSION)).toBeFalsy();
  });

  test("a keeper heartbeat sent before the lease lapses is refused too and the lapse still follows", async () => {
    timer.advanceTime(LEASE_MS - 1_000);
    const before = livenessSnapshot();
    expect(await keeper()).toMatchObject({ code: DAEMON_LIVENESS_OWNER_IS_PROXY_CODE });
    expect(livenessSnapshot()).toEqual(before);

    timer.advanceTime(1_001);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
  });
});
