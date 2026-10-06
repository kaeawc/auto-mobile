import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #10050: two harnesses' proxies bound to one device session contend for its
// liveness ownership against the daemon's real request handler, on a fake timer.
// A harness-supplied stable owner token lets a restarted proxy resume.

const SESSION = "contended-device-session";
const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

function daemonStateFor(sessionManager: SessionManager): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

interface ClaimResponse {
  claim: boolean;
  token: unknown;
  success: boolean;
  code?: string;
}

describe("proxy liveness owner token (#10050)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let responses: ClaimResponse[];
  let isAvailableSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    responses = [];
    await sessionManager.createSession(SESSION, "emulator-5554", "android", 60_000);
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(() => {
    isAvailableSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  function daemonBackedClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        const response = await handleDaemonRequest(
          { id: "request-1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
        responses.push({
          claim: params.claimLivenessOwnership === true,
          token: params.livenessOwnerToken,
          success: response.success,
          code: response.code,
        });
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
  }

  function proxyFor(livenessOwnerToken?: string, mintedToken = "minted-token"): DaemonMcpProxy {
    return new DaemonMcpProxy({
      initialSessionUuid: SESSION,
      livenessOwnerToken,
      idGenerator: new FakeIdGenerator([mintedToken]),
      clientFactory: () => daemonBackedClient(),
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });
  }

  test("claims with the harness-supplied token instead of minting one", async () => {
    const proxy = proxyFor("harness-token");
    try {
      await proxy.ensureConnected();

      expect(responses[0]).toEqual({
        claim: true,
        token: "harness-token",
        success: true,
        code: undefined,
      });
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("harness-token");
    } finally {
      await proxy.close();
    }
  });

  test.each([undefined, "", "   "])("mints a per-process token when given %j", async (token) => {
    const proxy = proxyFor(token);
    try {
      await proxy.ensureConnected();

      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("minted-token");
    } finally {
      await proxy.close();
    }
  });

  test.each([
    { first: "harness-a", second: "harness-b" },
    { first: "harness-b", second: "harness-a" },
  ])(
    "$second's proxy cannot take the session while $first's lease is live",
    async ({ first, second }) => {
      const owner = proxyFor(first);
      const challenger = proxyFor(second);
      try {
        await owner.ensureConnected();
        const claimed = sessionManager.getSession(SESSION)!;
        const before = {
          livenessOwnerToken: claimed.livenessOwnerToken,
          livenessPolicy: claimed.livenessPolicy,
          lastHeartbeat: claimed.lastHeartbeat,
          lastUsedAt: claimed.lastUsedAt,
          expiresAt: claimed.expiresAt,
        };
        responses.length = 0;

        await challenger.ensureConnected();

        expect(responses[0]).toEqual({
          claim: true,
          token: second,
          success: false,
          code: "liveness_owner_conflict",
        });
        expect(sessionManager.getSession(SESSION)).toMatchObject(before);
      } finally {
        await challenger.close();
        await owner.close();
      }
    },
  );

  test("the challenger's proxy claims once the owner's lease has expired", async () => {
    const owner = proxyFor("harness-a");
    await owner.ensureConnected();
    // The owner stops heartbeating (closed proxy) and its lease lapses.
    await owner.close();
    const leaseMs = sessionManager.getSession(SESSION)!.heartbeatTimeoutMs;
    timer.advanceTime(leaseMs + 1);
    const challenger = proxyFor("harness-b");
    try {
      await challenger.ensureConnected();

      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("harness-b");
    } finally {
      await challenger.close();
    }
  });

  test("a proxy restarted with the same stable token resumes without a conflict", async () => {
    const original = proxyFor("harness-a");
    await original.ensureConnected();
    await original.close();
    const lastHeartbeat = sessionManager.getSession(SESSION)!.lastHeartbeat;
    timer.advanceTime(3_000);
    responses.length = 0;

    const restarted = proxyFor("harness-a", "unused-minted-token");
    try {
      await restarted.ensureConnected();

      expect(responses[0]).toEqual({
        claim: true,
        token: "harness-a",
        success: true,
        code: undefined,
      });
      expect(sessionManager.getSession(SESSION)).toMatchObject({
        livenessOwnerToken: "harness-a",
        lastHeartbeat: lastHeartbeat + 3_000,
      });
    } finally {
      await restarted.close();
    }
  });

  test("a restart with a fresh per-process token is locked out while the old lease is live", async () => {
    const original = proxyFor("harness-a");
    await original.ensureConnected();
    await original.close();
    timer.advanceTime(3_000);
    responses.length = 0;

    const restarted = proxyFor(undefined, "fresh-process-token");
    try {
      await restarted.ensureConnected();

      expect(responses[0]).toMatchObject({ success: false, code: "liveness_owner_conflict" });
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("harness-a");
    } finally {
      await restarted.close();
    }
  });
});
