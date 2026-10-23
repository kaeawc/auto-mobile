import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy, type DaemonMcpProxyConfig } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_RELEASE_SESSION_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE } from "../../src/daemon/types";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/sessionBroker/provisioning/executionLiveness";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../../src/processLifecycle";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";

interface Rig {
  proxy: DaemonMcpProxy;
  client: FakeDaemonClient;
  sessions: SessionManager;
  timer: FakeTimer;
  wire: Array<{ method: string; params?: Record<string, unknown> }>;
  releasedDevices: string[];
  state: DaemonStateAccess;
  wedge: () => void;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.proxy.close();
    rig.sessions.stopCleanupTimer();
  }
});

function setup(config: Partial<DaemonMcpProxyConfig> = {}): Rig {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const wire: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const releasedDevices: string[] = [];
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => sessions,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({
        total: 2,
        idle: releasedDevices.length,
        assigned: 2 - releasedDevices.length,
        error: 0,
      }),
      releaseDevice: async (deviceId) => {
        releasedDevices.push(deviceId);
      },
    }),
  };
  let wedge = false;
  const client = new FakeDaemonClient({
    toolResultFor: (name, args) =>
      name === "getAndroid"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ runtime: { session: { sessionUuid: args.deviceId } } }),
              },
            ],
          }
        : undefined,
    onCallTool: async (name, args) => {
      if (name === "getAndroid") {
        await sessions.createSession(args.deviceId, `device-${args.deviceId}`, "android");
      }
    },
    onCallDaemonMethod: async (method, params) => {
      wire.push({ method, params });
      if (method === DAEMON_RELEASE_SESSION_METHOD && wedge) {
        return new Promise<never>(() => {});
      }
      const answer = await handleDaemonRequest(
        { id: "r", type: "daemon_request", method, params },
        state,
      );
      if (!answer.success) {
        throw Object.assign(new Error(answer.error), { code: answer.code });
      }
      return answer.result;
    },
  });
  const close = client.close.bind(client);
  client.close = async () => {
    wire.push({ method: "client.close" });
    await close();
  };
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    timer,
    clientFactory: () => client,
    daemonManager: manager,
    autoStartDaemon: false,
    daemonAvailabilityProbe: async () => true,
    idGenerator: new FakeIdGenerator(),
    ...config,
  });
  const rig = {
    proxy,
    client,
    sessions,
    timer,
    wire,
    releasedDevices,
    state,
    wedge: () => {
      wedge = true;
    },
  };
  rigs.push(rig);
  return rig;
}

// Pay one-time module/acquisition/release initialization outside each test's timing, as the
// liveness matrix does. Every case still constructs and exercises its own fake-clock rig.
beforeAll(async () => {
  const warm = setup();
  try {
    await warm.proxy.callTool("getAndroid", { deviceId: "warm" });
    await warm.proxy.close();
  } finally {
    warm.sessions.stopCleanupTimer();
    rigs.splice(rigs.indexOf(warm), 1);
  }
});

const releases = (rig: Rig) =>
  rig.wire.filter(({ method }) => method === DAEMON_RELEASE_SESSION_METHOD);

for (const count of [1, 2]) {
  test(`clean close immediately releases ${count} result-minted owned sessions before client close`, async () => {
    const rig = setup();
    for (let i = 0; i < count; i++) {
      await rig.proxy.callTool("getAndroid", { deviceId: `session-${i}` });
    }
    const token = rig.sessions.getSession("session-0")!.livenessOwnerToken;
    expect(token).toBeString();
    const at = rig.timer.now();
    await rig.proxy.close();
    expect(rig.timer.now()).toBe(at);
    expect(
      releases(rig)
        .map(({ params }) => params)
        .sort((a, b) => String(a?.sessionId).localeCompare(String(b?.sessionId))),
    ).toEqual(
      Array.from({ length: count }, (_, i) => ({
        sessionId: `session-${i}`,
        livenessOwnerToken: token,
      })),
    );
    expect(rig.wire.at(-1)?.method).toBe("client.close");
    expect(rig.releasedDevices).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(rig.sessions.hasSession(`session-${i}`)).toBe(false);
    }
  });
}

test("wedged releases run in parallel and close at the per-call bound", async () => {
  const rig = setup();
  await rig.proxy.callTool("getAndroid", { deviceId: "one" });
  await rig.proxy.callTool("getAndroid", { deviceId: "two" });
  rig.wedge();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    let done = false;
    const firstClose = rig.proxy.close();
    expect(rig.proxy.close()).toBe(firstClose);
    const closing = firstClose.then(() => {
      done = true;
    });
    await drainMicrotasks(64);
    expect(releases(rig)).toHaveLength(2);
    await rig.timer.advanceTimeAsync(BROKER_EXECUTION_RELEASE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(rig.client.isConnected()).toBe(true);
    await rig.timer.advanceTimeAsync(1);
    await closing;
    expect(done).toBe(true);
    expect(rig.client.isConnected()).toBe(false);
    expect(BROKER_EXECUTION_RELEASE_TIMEOUT_MS).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
    expect(warn.mock.calls).toHaveLength(2);
  } finally {
    warn.mockRestore();
  }
});

test("configured initial binding survives close", async () => {
  const rig = setup({ initialSessionUuid: "initial" });
  await rig.sessions.createSession("initial", "device-initial", "android");
  await rig.proxy.claimInitialSession();
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
  expect(rig.sessions.hasSession("initial")).toBe(true);
});

test("a harness stable token preserves result-minted sessions", async () => {
  const rig = setup({ livenessOwnerToken: "stable" });
  await rig.proxy.callTool("getAndroid", { deviceId: "stable-session" });
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
  expect(rig.sessions.hasSession("stable-session")).toBe(true);
});

test("CLI-owned sessions survive exit", async () => {
  const rig = setup();
  await rig.proxy.callTool("getAndroid", { deviceId: "cli" });
  await rig.proxy.adoptCliSessionLiveness();
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
  expect(rig.sessions.getSession("cli")?.livenessPolicy).toBe("cli-idle");
});

test("a session merely named in tool arguments is never released", async () => {
  const rig = setup();
  await rig.sessions.createSession("theirs", "device-theirs", "android");
  await rig.proxy.callTool("tapOn", { sessionUuid: "theirs" });
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
  expect(rig.sessions.hasSession("theirs")).toBe(true);
});

for (const owner of ["successor", undefined]) {
  test(`close cannot release after ownership transferred to ${owner ?? "handoff"}`, async () => {
    const rig = setup();
    await rig.proxy.callTool("getAndroid", { deviceId: "mine" });
    const session = rig.sessions.getSession("mine")!;
    session.livenessOwnerToken = owner;
    const clocks = [session.lastHeartbeat, session.lastOwnerHeartbeat, session.lastUsedAt];
    await rig.proxy.close();
    expect(releases(rig)).toHaveLength(1);
    expect(rig.sessions.getSession("mine")).toBe(session);
    expect([session.lastHeartbeat, session.lastOwnerHeartbeat, session.lastUsedAt]).toEqual(clocks);
    const response = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_RELEASE_SESSION_METHOD,
        params: { sessionId: "mine", livenessOwnerToken: "predecessor" },
      },
      rig.state,
    );
    expect(response).toMatchObject({ success: false, code: DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE });
    expect(rig.releasedDevices).toEqual([]);
  });
}

for (const token of [undefined, "owner", "other"]) {
  test(`releaseSession owner guard: ${token ?? "absent token"}`, async () => {
    const rig = setup();
    const session = await rig.sessions.createSession("guard", "device-guard", "android");
    await rig.sessions.claimLivenessOwnership("guard", "owner");
    const clocks = [session.lastHeartbeat, session.lastOwnerHeartbeat, session.lastUsedAt];
    let probes = 0;
    rig.sessions.setStallProbe(() => {
      probes++;
    });
    const response = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_RELEASE_SESSION_METHOD,
        params: { sessionId: "guard", ...(token ? { livenessOwnerToken: token } : {}) },
      },
      rig.state,
    );
    if (token === "other") {
      expect(probes).toBe(0);
      expect(response).toMatchObject({
        success: false,
        code: DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
      });
      expect(rig.sessions.getSession("guard")).toBe(session);
      expect(session.assignedDevice).toBe("device-guard");
      expect([session.lastHeartbeat, session.lastOwnerHeartbeat, session.lastUsedAt]).toEqual(
        clocks,
      );
      expect(rig.releasedDevices).toEqual([]);
    } else {
      expect(response.success).toBe(true);
      expect(rig.sessions.hasSession("guard")).toBe(false);
      expect(rig.releasedDevices).toEqual(["device-guard"]);
    }
  });
}

test("token-bearing unknown and already released sessions remain idempotent", async () => {
  const rig = setup();
  await rig.sessions.createSession("gone", "device-gone", "android");
  await rig.sessions.releaseSession("gone");
  for (const sessionId of ["unknown", "gone"]) {
    const response = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_RELEASE_SESSION_METHOD,
        params: { sessionId, livenessOwnerToken: "token" },
      },
      rig.state,
    );
    expect(response).toMatchObject({
      success: true,
      result: { alreadyReleased: sessionId === "gone", known: sessionId === "gone" },
    });
  }
});

test("terminal released bindings are not released again", async () => {
  const rig = setup();
  await rig.proxy.callTool("getAndroid", { deviceId: "gone" });
  await rig.sessions.releaseSession("gone");
  rig.client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "gone", "explicit-release");
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
});

test("close with no connected daemon performs no lifecycle RPC", async () => {
  const rig = setup();
  await rig.proxy.close();
  expect(rig.wire).toEqual([]);
});

test("one-shot CLI sessions survive close before liveness is declared", async () => {
  const rig = setup({ oneShotCli: true });
  await rig.proxy.callTool("getAndroid", { deviceId: "undeclared-cli" });
  expect(rig.sessions.getSession("undeclared-cli")?.livenessPolicy).toBe("heartbeat");
  await rig.proxy.close();
  expect(releases(rig)).toEqual([]);
  expect(rig.sessions.hasSession("undeclared-cli")).toBe(true);
});
