import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import type { McpForwardRoute } from "../../src/daemon/socketServer";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { expect, spyOn } from "bun:test";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
} from "../../src/daemon/wire/constants";
import { sessionOwnerLeaseSnapshot } from "../../src/daemon/livenessOwnerLease";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSocket } from "../fakes/FakeNetServer";
import { daemonHeartbeatHandler } from "../helpers/daemonHeartbeatHandler";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { warmedTests } from "../helpers/warmedTests";

const test = warmedTests(() => {});

// The route a forwarded call takes is scripted; everything downstream of it is the real server.
class OwnerCallServer extends UnixSocketServerHarness {
  onRoute: () => void = () => {};

  protected override getMcpForwardRoute(): McpForwardRoute {
    this.onRoute();
    return { executionKey: "test", clientKey: "test" };
  }
}

function setup(markAutolockSession: () => Promise<void> = async () => {}) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence, {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("android", [device]);
  devices.setBootedDevices("ios", []);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "test-daemon", {
      timer,
      deviceManager: devices,
      deviceSessionRepository: { markAutolockSession },
    }),
  );
  const heartbeat = (id: string, token: string) =>
    daemonHeartbeatHandler(manager)("daemon/heartbeat", {
      sessionId: id,
      livenessOwnerToken: token,
      claimLivenessOwnership: true,
    });
  return { timer, persistence, manager, pool, device, heartbeat };
}

// The fallback lets the pre-fix run expose the claim defect before this API exists.
const begin = (pool: DevicePool, connection = "conn-1", token = "minter") =>
  pool.beginMcpSessionOwnerCall?.(connection, token) ?? (() => {});

async function mint(h: ReturnType<typeof setup>) {
  const session = await h.manager.createSession("S", "device", "android");
  expect(h.manager.bindAcquiredLivenessOwnerToken("S", "minter")).toBe(true);
  return session;
}

const unchanged = (session: Session) => ({
  lastHeartbeat: session.lastHeartbeat,
  lastOwnerHeartbeat: session.lastOwnerHeartbeat,
  hasReceivedHeartbeat: session.hasReceivedHeartbeat,
  stallForgivenAt: session.stallForgivenAt,
  expiresAt: session.expiresAt,
  lastUsedAt: session.lastUsedAt,
  idleStallForgivenAt: session.idleStallForgivenAt,
  activityGeneration: session.activityGeneration,
  ownership: session.ownership,
  livenessOwnerToken: session.livenessOwnerToken,
  awaitingOwnerSince: session.awaitingOwnerSince,
});

test("pending real autolock mint holds against rival at 8001 and 60000 ms until owner call ends", async () => {
  const write = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const h = setup(() => {
    entered.resolve();
    return write.promise;
  });
  await h.pool.initializeWithDevices([h.device]);
  h.pool.declareMcpSessionLivenessOwnerToken("conn-1", "minter");
  const end = begin(h.pool);
  const acquiring = h.pool.autolockDevice(
    h.device.deviceId,
    "android",
    "conn-1",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "automationReady",
    undefined,
    { autolockEnabled: true },
  );
  try {
    await entered.promise;
    const id = h.pool.getAllDevices().find((device) => device.id === h.device.deviceId)!.sessionId!;
    const session = h.manager.peekSession(id)!;
    expect(session.livenessOwnerToken).toBe("minter");
    for (const elapsed of [8_001, 60_000]) {
      h.timer.setCurrentTime(session.livenessOwnerBoundAt! + elapsed);
      await expect(h.heartbeat(id, "rival")).rejects.toMatchObject({
        code: "liveness_owner_conflict",
      });
      expect(session.livenessOwnerToken).toBe("minter");
      expect(h.manager.getOwnerLeaseHold(id)).toEqual({
        state: "live",
        remainingMs: 4_000,
        holdRemainingMs: 8_000,
      });
    }
    write.resolve();
    expect(await acquiring).toBe(id);
    end();
    await expect(h.heartbeat(id, "minter")).resolves.toBeDefined();
    expect(session.lastOwnerHeartbeat).toBe(h.timer.now());
  } finally {
    write.resolve();
    await acquiring;
    end();
  }
});

test("owner call end restarts the bounded mint lease at exactly 8000/8001 ms", async () => {
  const h = setup();
  const session = await mint(h);
  const end = begin(h.pool);
  h.timer.setCurrentTime(60_000);
  end();
  h.timer.setCurrentTime(68_000);
  await expect(h.heartbeat("S", "rival")).rejects.toMatchObject({
    code: "liveness_owner_conflict",
  });
  expect(session.livenessOwnerToken).toBe("minter");
  h.timer.setCurrentTime(68_001);
  await expect(h.heartbeat("S", "rival")).resolves.toBeDefined();
  expect(session.livenessOwnerToken).toBe("rival");
});

test("owner call end changes only the mint clock, is idempotent and never moves it backwards", async () => {
  const h = setup();
  const session = await mint(h);
  const before = unchanged(session);
  const writes = spyOn(h.persistence, "recordLivenessOwnership");
  const end = begin(h.pool);
  h.timer.setCurrentTime(10_000);
  end();
  expect(session.livenessOwnerBoundAt).toBe(10_000);
  expect(unchanged(session)).toEqual(before);
  h.timer.setCurrentTime(12_000);
  end();
  expect(session.livenessOwnerBoundAt).toBe(10_000);
  const nextEnd = begin(h.pool);
  session.livenessOwnerBoundAt = 20_000;
  nextEnd();
  expect(session.livenessOwnerBoundAt).toBe(20_000);
  expect(unchanged(session)).toEqual(before);
  expect(writes).not.toHaveBeenCalled();
  writes.mockRestore();
});

test("another token's in-flight call and its end defend no silent minter", async () => {
  const h = setup();
  const session = await mint(h);
  const end = begin(h.pool, "conn-2", "other");
  h.timer.setCurrentTime(8_001);
  end();
  expect(session.livenessOwnerBoundAt).toBe(0);
  const stillRunning = begin(h.pool, "conn-2", "other");
  await expect(h.heartbeat("S", "rival")).resolves.toBeDefined();
  expect(session.livenessOwnerToken).toBe("rival");
  stillRunning();
});

test("released connection's call stops defending immediately and its late end does not restart", async () => {
  const h = setup();
  const session = await mint(h);
  const end = begin(h.pool);
  h.timer.setCurrentTime(60_000);
  expect(h.manager.getOwnerLeaseHold("S")?.state).toBe("live");
  // This manager-created session has no pool binding for the close path to release.
  h.pool.releaseMcpSessionBindings("conn-1");
  expect(h.manager.peekSession("S")).toBe(session);
  expect(h.manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
  end();
  expect(session.livenessOwnerBoundAt).toBe(0);
  await expect(h.heartbeat("S", "rival")).resolves.toBeDefined();
});

test("heartbeated owner gets no claim extension from its own in-flight call or end", async () => {
  const h = setup();
  const session = await mint(h);
  await h.heartbeat("S", "minter");
  const end = begin(h.pool);
  h.timer.setCurrentTime(8_001);
  expect(sessionOwnerLeaseSnapshot(session, h.timer.now(), true).lastHeartbeat).toBe(0);
  await expect(h.heartbeat("S", "rival")).resolves.toBeDefined();
  end();
  expect(session.livenessOwnerToken).toBe("rival");
  expect(session.livenessOwnerBoundAt).toBeUndefined();
});

test("mint owner call and lease restart leave reap and suspect judgement identical to ownerless", async () => {
  const h = setup();
  const session = await mint(h);
  await h.manager.createSession("ownerless", "other-device", "android");
  const end = begin(h.pool);
  for (const at of [0, 4_000, 4_001, 8_000, 8_001, 60_000]) {
    h.timer.setCurrentTime(at);
    expect(h.manager.getSessionLeaseState("S")).toEqual(
      h.manager.getSessionLeaseState("ownerless"),
    );
    expect(h.manager.ownerLeaseAwaitsReap("S")).toBe(h.manager.ownerLeaseAwaitsReap("ownerless"));
  }
  end();
  expect(session.livenessOwnerBoundAt).toBe(60_000);
  expect(h.manager.getSessionLeaseState("S")).toEqual(h.manager.getSessionLeaseState("ownerless"));
});

test("overlapping calls and connections keep the exact token live until the final end", async () => {
  const h = setup();
  await mint(h);
  const first = begin(h.pool);
  const second = begin(h.pool);
  const otherConnection = begin(h.pool, "conn-2");
  h.timer.setCurrentTime(10_000);
  first();
  first();
  h.pool.releaseMcpSessionBindings("conn-1");
  second();
  h.timer.setCurrentTime(60_000);
  expect(h.manager.getOwnerLeaseHold("S")?.state).toBe("live");
  otherConnection();
  expect(h.manager.getOwnerLeaseHold("S")?.state).toBe("live");
  h.timer.setCurrentTime(68_001);
  expect(h.manager.getOwnerLeaseHold("S")?.state).toBe("lapsed");
});

for (const outcome of [
  "success",
  "tool-error",
  "throw",
  "cancel",
  "restore-close",
  "route-throw",
  "begin-throw",
  "end-throw",
  "no-token",
  "blank-token",
  "uninitialized",
] as const) {
  test(`socket owner call bookkeeping covers ${outcome}`, async () => {
    const events: string[] = [];
    const calls: Array<[string, string]> = [];
    let ends = 0;
    const pool = {
      refreshDevices: async () => 0,
      releaseDevice: async () => {},
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      declareMcpSessionLivenessOwnerToken: () => {
        events.push("declare");
      },
      restoreOwnedDeviceSessionsForMcpSession: async () => {
        events.push("restore");
        if (outcome === "restore-close") {
          socket.destroy();
        }
        return [];
      },
      beginMcpSessionOwnerCall: (connection: string, token: string) => {
        events.push("begin");
        calls.push([connection, token]);
        if (outcome === "begin-throw") {
          throw new Error("begin failed");
        }
        return () => {
          ends++;
          events.push("end");
          if (outcome === "end-throw") {
            throw new Error("end failed");
          }
        };
      },
    };
    const server = new OwnerCallServer(
      "/fake/owner-call.sock",
      {
        isInitialized: () => outcome !== "uninitialized",
        getSessionManager: () => ({
          hasSession: () => false,
          getSession: () => null,
          getDeviceLabels: () => undefined,
          releaseSession: async () => null,
        }),
        getDevicePool: () => pool,
        getDeviceSessionRegistry: () => ({ list: () => [] }),
      },
      new FakeTimer(),
      undefined,
      { mcpDispatcher: unreachableMcpDispatcher },
      undefined,
      { bindLock: fakeBindLock },
    );
    server.allowRequests();
    const socket = new FakeSocket();
    server.connect(socket);
    const connection = server.sessionIds[0]!;
    server.localRequestHandler = async () => undefined;
    server.onRoute = () => {
      events.push("route");
      if (outcome === "route-throw") {
        throw new Error("route failed");
      }
    };
    server.mcpForwarder = async () => {
      events.push("forward");
      if (outcome === "cancel" || outcome === "restore-close") {
        socket.destroy();
        throw new Error("cancelled");
      }
      if (outcome === "throw") {
        throw new Error("forward failed");
      }
      return { content: [], ...(outcome === "tool-error" ? { isError: true } : {}) };
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const hasToken = !["no-token", "blank-token", "uninitialized", "restore-close"].includes(
        outcome,
      );
      const response = await server.dispatchRequest(
        connection,
        socket,
        {
          id: "owner-call",
          type: "mcp_request",
          method: "tools/call",
          params: {
            name: "observe",
            arguments:
              outcome === "no-token"
                ? {}
                : {
                    [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]:
                      outcome === "blank-token" ? "  " : "minter",
                    ...(outcome === "restore-close"
                      ? { [DAEMON_OWNED_SESSIONS_PARAM]: ["retained"] }
                      : {}),
                  },
          },
        },
        0,
      );
      expect(calls).toEqual(hasToken ? [[connection, "minter"]] : []);
      expect(ends).toBe(hasToken && outcome !== "begin-throw" ? 1 : 0);
      if (hasToken) {
        expect(events.slice(0, 2)).toEqual(["declare", "begin"]);
      }
      if (outcome === "cancel" || outcome === "restore-close") {
        expect(response).toBeUndefined();
      } else if (["throw", "route-throw"].includes(outcome)) {
        expect(response?.success).toBe(false);
      } else {
        expect(response?.success).toBe(true);
      }
      if (outcome === "begin-throw" || outcome === "end-throw") {
        expect(
          warn.mock.calls.some(([message]) =>
            String(message).includes(outcome === "begin-throw" ? "begin failed" : "end failed"),
          ),
        ).toBe(true);
      }
    } finally {
      warn.mockRestore();
      socket.destroy();
      await server.close();
    }
  });
}
