import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_HEARTBEAT_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// Contract: a live owner heartbeating on time is never released, and the database is off the
// heartbeat path (#11646).
//
// The proxy's first heartbeat for a session claims it, and the daemon answers that claim only
// once the ownership row is written. The daemon counts the accepted claim as the owner's
// heartbeat when it arrives, so the 4 s lease runs from then. The proxy awaits that reply before
// its keeper starts, so it must keep heartbeating on the keeper's cadence while the reply is
// outstanding: a 9 s write must not leave the session without a heartbeat for 9 s.
//
// The real proxy talks to the real request handlers, SessionManager and SessionHeartbeatMonitor
// through a fake client; the ownership write is gated and time is a FakeTimer.

const SESSION = "claim-pending-session";
const TOKEN = "claim-pending-owner";
const INTERVAL_MS = 2_000;

describe("the proxy heartbeats behind a claim whose reply is still outstanding", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let createProxy: (binding: "startup-bound" | "resumed-by-token") => DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let openOwnershipWrite: () => void;

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push(reason);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await manager.createSession(SESSION, "emulator-5554", "android");
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    client = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        const response = await handleDaemonRequest(
          { id: method, type: "daemon_request", method, params },
          state,
        );
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
        return response.result;
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };

    // Every ownership write waits until the test opens the gate.
    const gate = Promise.withResolvers<void>();
    openOwnershipWrite = gate.resolve;
    const write = persistence.recordLivenessOwnership.bind(persistence);
    persistence.recordLivenessOwnership = async (sessionUuid, ownerToken) => {
      await gate.promise;
      await write(sessionUuid, ownerToken);
    };
    createProxy = (binding) =>
      new DaemonMcpProxy({
        livenessOwnerToken: TOKEN,
        ...(binding === "startup-bound" ? { initialSessionUuid: SESSION } : {}),
        heartbeatIntervalMs: INTERVAL_MS,
        clientFactory: () => client,
        daemonManager,
        autoStartDaemon: false,
        timer,
      });
    proxy = createProxy("startup-bound");
  });

  afterEach(async () => {
    openOwnershipWrite();
    await proxy.close();
    isAvailableSpy.mockRestore();
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  const heartbeats = () =>
    client.callDaemonMethodCalls.filter((call) => call.method === DAEMON_HEARTBEAT_METHOD);

  /** Connect far enough that the daemon has accepted the claim; its reply waits on the write. */
  async function connectUntilClaimAccepted(): Promise<{ connecting: Promise<void> }> {
    const connecting = proxy.ensureConnected();
    const accepted = () =>
      manager.getSession(SESSION)?.livenessOwnershipClaims?.has(TOKEN) === true &&
      manager.hasLivenessOwnership(SESSION, TOKEN);
    for (let turn = 0; turn < 200 && !accepted(); turn++) {
      await Promise.resolve();
    }
    expect(accepted()).toBe(true);
    // Wrapped: an async function returning the promise itself would wait for it.
    return { connecting };
  }

  /** Advance `ms`, then judge the session as the daemon's monitor would at that instant. */
  async function advanceAndScan(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms);
    await monitor.tick();
    expect(reaped).toEqual([]);
    expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
  }

  test.each([3_000, 6_000, 9_000])(
    "a claim answered after %d ms never leaves the session without a heartbeat for a lease",
    async (writeMs) => {
      const { connecting } = await connectUntilClaimAccepted();
      expect(heartbeats()).toHaveLength(1);

      for (let elapsed = INTERVAL_MS; elapsed <= writeMs; elapsed += INTERVAL_MS) {
        await advanceAndScan(INTERVAL_MS);
      }
      await advanceAndScan(writeMs % INTERVAL_MS);
      // One heartbeat per interval while the claim's reply was outstanding, each a plain tick.
      const renewals = heartbeats().slice(1);
      expect(renewals).toHaveLength(Math.floor(writeMs / INTERVAL_MS));
      expect(renewals.every((call) => call.params.claimLivenessOwnership === undefined)).toBe(true);

      openOwnershipWrite();
      await connecting;
      // The keeper takes over: the session stays live across its first ticks.
      for (let tick = 0; tick < 3; tick++) {
        await advanceAndScan(INTERVAL_MS);
      }
      expect(manager.hasLivenessOwnership(SESSION, TOKEN)).toBe(true);
    },
  );

  test("a claim answered at once sends no extra heartbeat and leaves no timer behind", async () => {
    openOwnershipWrite();
    await proxy.ensureConnected();
    const intervals = timer.getPendingIntervalCount();

    await timer.advanceTimeAsync(INTERVAL_MS);

    // The claim, then the keeper's first tick: nothing in between.
    expect(heartbeats()).toHaveLength(2);
    expect(timer.getPendingIntervalCount()).toBe(intervals);
  });

  test("the renewals end with the reply: afterwards only the keeper heartbeats", async () => {
    const { connecting } = await connectUntilClaimAccepted();
    await advanceAndScan(INTERVAL_MS);
    await advanceAndScan(INTERVAL_MS);
    openOwnershipWrite();
    await connecting;
    await advanceAndScan(INTERVAL_MS);
    const settled = heartbeats().length;
    const intervals = timer.getPendingIntervalCount();

    await advanceAndScan(3 * INTERVAL_MS);

    expect(heartbeats().length - settled).toBe(3);
    expect(timer.getPendingIntervalCount()).toBe(intervals);
  });

  test("a session resumed by its owner token is heartbeated while its re-claim is outstanding", async () => {
    // A restarted daemon knows the token owns the session but has no claim on record for it.
    expect(manager.claimUnownedLivenessOwnership(SESSION, TOKEN)).toBe(true);
    proxy = createProxy("resumed-by-token");
    const { connecting } = await connectUntilClaimAccepted();
    expect(heartbeats()).toHaveLength(1);

    for (let tick = 0; tick < 4; tick++) {
      await advanceAndScan(INTERVAL_MS);
    }
    expect(heartbeats()).toHaveLength(5);

    openOwnershipWrite();
    await connecting;
    for (let tick = 0; tick < 3; tick++) {
      await advanceAndScan(INTERVAL_MS);
    }
  });

  test("a proxy closed while its claim is outstanding stops heartbeating", async () => {
    const { connecting } = await connectUntilClaimAccepted();
    await advanceAndScan(INTERVAL_MS);
    const sent = heartbeats().length;

    const closing = proxy.close();
    openOwnershipWrite();
    await Promise.allSettled([connecting, closing]);
    await timer.advanceTimeAsync(3 * INTERVAL_MS);

    expect(heartbeats()).toHaveLength(sent);
  });
});
