import { expect, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_VERSION,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
} from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { getDeviceSessionIdFromResult } from "../../src/server/deviceSessionResult";
import { DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { LivenessScenario } from "../helpers/livenessScenarioHarness";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

let scenario: LivenessScenario | undefined;
const proxies: DaemonMcpProxy[] = [];
let clockOffset: unknown;
const test = warmedTests(async () => {
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  if (scenario) {
    await scenario.stop();
    scenario = undefined;
    Reflect.set(executionTracker, "sessionClockOffsetProvider", clockOffset);
    expect(Reflect.get(executionTracker, "sessionClockOffsetProvider")).toBe(clockOffset);
  }
  resetDbWriteBarrier();
  expect(executionTracker.getActiveExecutionCount()).toBe(0);
  expect(ToolRegistry.getAllTools()).toHaveLength(0);
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
  expect(getDbWriteBarrier().inFlightCount()).toBe(0);
  expect(getDbWriteBarrier().isDraining()).toBe(false);
  expect(Reflect.get(PlatformDeviceManagerFactory, "instance")).toBeNull();
  expect(Reflect.get(PlatformDeviceManagerFactory, "injectedManager")).toBeNull();
});

async function setup(oneShotCli = false, autolock = false) {
  clockOffset = Reflect.get(executionTracker, "sessionClockOffsetProvider");
  const s = (scenario = await LivenessScenario.start({ freshConnectionIdPerDial: true, autolock }));
  const clients: FakeDaemonClient[] = [];
  let loseHeartbeats = true;
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    timer: s.timer,
    idGenerator: new FakeIdGenerator(["minter-token"]),
    daemonManager: manager,
    autoStartDaemon: false,
    oneShotCli,
    clientFactory: () => {
      const client = new FakeDaemonClient({
        daemon: s.daemonConnection("minter"),
        onCallDaemonMethod: (method) =>
          method === "daemon/heartbeat" && loseHeartbeats ? {} : undefined,
      });
      clients.push(client);
      return client;
    },
  });
  proxies.push(proxy);
  const acquire = async () => {
    const result = await proxy.callTool("getAndroid", { deviceId: "emulator-5554" });
    await drainMicrotasks(64);
    return getDeviceSessionIdFromResult(result)!;
  };
  return {
    s,
    proxy,
    clients,
    acquire,
    deliverHeartbeats: () => {
      loseHeartbeats = false;
    },
  };
}

test("pool keeps the silent holder retryable through suspect and the scan gap without stamping clocks", async () => {
  const { s } = await setup();
  const id = await s.acquire();
  await s.idle(2_000);
  const session = s.daemon.manager.getSession(id)!;
  expect(session.hasReceivedHeartbeat).toBe(true);
  expect(s.daemon.pool.holderReleaseRemainingMs(id)).toBeUndefined();
  s.dropHeartbeats = true;
  const heartbeatAt = session.lastOwnerHeartbeat!;
  const before = [session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat];
  for (const age of [4_001, 8_000, 8_001, 9_999]) {
    await s.idle(heartbeatAt + age - s.timer.now());
    const hint = s.daemon.pool.holderReleaseRemainingMs(id);
    expect(hint).toBeGreaterThanOrEqual(1);
    expect(hint).toBeLessThanOrEqual(4_000);
    if (age > 8_000) {
      expect(hint).toBeLessThanOrEqual(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
    }
    expect([session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat]).toEqual(before);
    expect(s.daemon.manager.hasSession(id)).toBe(true);
  }
  await s.idle(1);
  expect(s.daemon.manager.hasSession(id)).toBe(false);
  expect(s.releaseOf(id)).toMatchObject({ at: heartbeatAt + 10_000, reason: "heartbeat-timeout" });
});

for (const autolock of [false, true]) {
  test(`clean close before any heartbeat immediately frees a ${autolock ? "autolock" : "explicit"} mint`, async () => {
    const { s, proxy, clients, acquire } = await setup(false, autolock);
    const id = await acquire();
    const session = s.daemon.manager.getSession(id)!;
    expect(session.hasReceivedHeartbeat).toBe(false);
    // Check the close result before the token pin so this reproduces the actual close failure.
    await proxy.close();
    expect(s.daemon.manager.hasSession(id)).toBe(false);
    expect(s.poolState().sessionId).toBeNull();
    expect(session.livenessOwnerToken).toBe("minter-token");
    expect(clients[0]!.callToolCalls[0]!.params[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]).toBe(
      "minter-token",
    );
  });
}

test("acquisition token stamps no clocks and the first claiming heartbeat still wins", async () => {
  const { s, proxy, acquire, clients, deliverHeartbeats } = await setup();
  const id = await acquire();
  const session = s.daemon.manager.getSession(id)!;
  expect(session.livenessOwnerToken).toBe("minter-token");
  expect(session.hasReceivedHeartbeat).toBe(false);
  expect(session.lastOwnerHeartbeat).toBeUndefined();
  const before = [session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat];
  expect(s.daemon.manager.bindAcquiredLivenessOwnerToken(id, "rival-token")).toBe(false);
  expect([session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat]).toEqual(before);
  deliverHeartbeats();
  const claims = spyOn(s.daemon.manager, "claimLivenessOwnership");
  try {
    const ack = await clients[0]!.callDaemonMethod("daemon/heartbeat", {
      sessionId: id,
      livenessOwnerToken: "minter-token",
      claimLivenessOwnership: true,
    });
    expect(ack).toMatchObject({ sessionId: id });
    expect(await claims.mock.results.at(-1)?.value).toBe("claimed");
  } finally {
    claims.mockRestore();
  }
  expect(session.hasReceivedHeartbeat).toBe(true);
  await proxy.close();
});

test("token binding preserves the never-heartbeated release scan", async () => {
  const { s, acquire } = await setup();
  const id = await acquire();
  expect(s.daemon.manager.getSession(id)?.livenessOwnerToken).toBe("minter-token");
  await s.idle(DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS);
  expect(s.daemon.manager.hasSession(id)).toBe(true);
  await s.idle(
    DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS -
      (DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS % DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS),
  );
  expect(s.daemon.manager.hasSession(id)).toBe(false);
  expect(s.releaseOf(id)).toMatchObject({ at: 6_000, reason: "missing-first-heartbeat" });
});

test("rival token cannot release a new mint and a tokenless release keeps today's policy", async () => {
  const { s, acquire } = await setup();
  const id = await acquire();
  const session = s.daemon.manager.getSession(id)!;
  expect(session.livenessOwnerToken).toBe("minter-token");
  const before = [session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat];
  const rival = s.addProxy({
    token: "rival-token",
    client: (daemon) => new FakeDaemonClient({ daemon }),
  });
  const named = await rival.callTool("observe", { sessionUuid: id });
  expect(named).not.toMatchObject({ isError: true });
  const response = await s.daemonMethod(
    "daemon/releaseSession",
    { sessionId: id, livenessOwnerToken: "rival-token" },
    "rival-release",
  );
  expect(response).toMatchObject({ success: false, code: "liveness_owner_not_owner" });
  expect([session.lastHeartbeat, session.lastUsedAt, session.lastOwnerHeartbeat]).toEqual(before);
  const tokenless = await s.daemonMethod(
    "daemon/releaseSession",
    { sessionId: id },
    "tokenless-release",
  );
  expect(tokenless.success).toBe(true);
  expect(s.daemon.manager.hasSession(id)).toBe(false);
});

test("one-shot CLI acquisition wire stays tokenless and its session stays ownerless until CLI claim", async () => {
  const { s, proxy, clients, acquire, deliverHeartbeats } = await setup(true);
  const id = await acquire();
  const session = s.daemon.manager.getSession(id)!;
  expect(clients[0]!.callToolCalls[0]!.params).not.toHaveProperty(
    DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  );
  expect(session.livenessOwnerToken).toBeUndefined();
  deliverHeartbeats();
  await proxy.adoptCliSessionLiveness();
  expect(session.livenessPolicy).toBe("cli-idle");
  expect(session.livenessOwnerToken).toBe("minter-token");
  await proxy.callTool("listDevices", {});
  expect(clients[0]!.callToolCalls.at(-1)!.params).not.toHaveProperty(
    DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  );
});

test("a declared CLI proxy keeps the existing tokenless discovery wire", async () => {
  const { proxy, clients, acquire, deliverHeartbeats } = await setup();
  await acquire();
  deliverHeartbeats();
  await proxy.adoptCliSessionLiveness();
  await proxy.callTool("listDevices", {});
  expect(clients[0]!.callToolCalls.at(-1)!.params).not.toHaveProperty(
    DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  );
});
