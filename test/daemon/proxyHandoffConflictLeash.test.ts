import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, daemonResponseError } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { LIVE_OWNER_HANDOFF_ALLOWANCE_MS } from "../../src/daemon/proxyLivenessRecovery";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10701: the documented restarted-harness handoff (a fresh token plus --initial-session-uuid S)
// is locked out while the previous owner's lease is live and then wins. The latest-binding
// conflict leash used the proxy's own lease config, measured from the first refusal, so the
// handoff was fenced for good when the old proxy kept heartbeating a little after the new one
// started, or when the daemon's lease for the session was longer than the proxy's. The leash now
// follows the daemon's report of the owner's hold, and only an owner that keeps renewing past the
// handoff allowance fences the challenger.

const SESSION = "handoff-session";
const INTERVAL_MS = PROXY_HEARTBEAT_INTERVAL_MS;
const PROXY_LEASE_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS;
const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

describe("#10701: a restarted harness's handoff waits out the daemon's lease for the session", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let state: DaemonStateAccess;
  let newProxy: DaemonMcpProxy;
  let newClaims: Array<{ success: boolean; code?: string }>;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  async function heartbeat(token: string, claim: boolean) {
    return await handleDaemonRequest(
      {
        id: `hb-${token}`,
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessPolicy: "heartbeat",
          livenessOwnerToken: token,
          ...(claim ? { claimLivenessOwnership: true } : {}),
        },
      },
      state,
    );
  }

  async function setUp(daemonLeaseMs: number): Promise<void> {
    await sessionManager.createSession(
      SESSION,
      "emulator-5554",
      "android",
      10 * 60_000,
      daemonLeaseMs,
    );
    // The old harness's proxy owns the session.
    expect((await heartbeat("old-harness", true)).success).toBe(true);
    const client = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        const response = await handleDaemonRequest(
          { id: "new", type: "daemon_request", method, params },
          state,
        );
        newClaims.push({ success: response.success, code: response.code });
        if (!response.success) {
          // The real socket client's mapping of a failed daemon response.
          throw daemonResponseError({ id: "new", type: "mcp_response", ...response });
        }
      },
    });
    newProxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: (() => {
        const manager = new FakeDaemonManager();
        manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
        return manager;
      })(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: PROXY_LEASE_MS,
      livenessOwnerToken: "new-harness",
      initialSessionUuid: SESSION,
    });
    await newProxy.claimInitialSession();
    // The agent switches to the new harness and calls right away.
    await newProxy.callTool("observe", {});
  }

  /** The old proxy keeps heartbeating for `forMs` at its cadence, then exits. */
  async function oldOwnerHeartbeatsFor(forMs: number): Promise<void> {
    const until = timer.now() + forMs;
    while (timer.now() < until) {
      await timer.advanceTimeAsync(INTERVAL_MS);
      await heartbeat("old-harness", false);
    }
  }

  beforeEach(() => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    state = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => DEVICE_POOL,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    newClaims = [];
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await newProxy?.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  test("overlap: the old proxy heartbeats 20 s after the new one starts, then the new one owns the session", async () => {
    await setUp(PROXY_LEASE_MS);
    await oldOwnerHeartbeatsFor(20_000);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("old-harness");

    await timer.advanceTimeAsync(PROXY_LEASE_MS + SUSPECT_GRACE_MS + INTERVAL_MS * 2);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("new-harness");
    await expect(newProxy.callTool("observe", {})).resolves.toBeDefined();
  });

  test("a daemon lease longer than the proxy's: the handoff still lands once that lease lapses", async () => {
    const daemonLeaseMs = 30_000;
    await setUp(daemonLeaseMs);

    // Well past the proxy's own lease plus grace, the daemon still holds the session for the
    // old owner, and the new proxy keeps claiming.
    await timer.advanceTimeAsync(daemonLeaseMs);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("old-harness");
    expect(newClaims.at(-1)).toMatchObject({ success: false, code: "liveness_owner_conflict" });

    await timer.advanceTimeAsync(SUSPECT_GRACE_MS + INTERVAL_MS * 2);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("new-harness");
    await expect(newProxy.callTool("observe", {})).resolves.toBeDefined();
  });

  test("live owner: an owner that never stops keeps the session, and the challenger is fenced", async () => {
    await setUp(PROXY_LEASE_MS);
    await oldOwnerHeartbeatsFor(LIVE_OWNER_HANDOFF_ALLOWANCE_MS + INTERVAL_MS * 3);

    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("old-harness");
    const claimsBefore = newClaims.length;
    await oldOwnerHeartbeatsFor(INTERVAL_MS * 3);
    expect(newClaims.length).toBe(claimsBefore);
    await expect(newProxy.callTool("observe", {})).rejects.toMatchObject({
      reason: "liveness-owner-conflict",
    });
  });
});
