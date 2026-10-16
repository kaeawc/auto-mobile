import { afterEach, describe, expect, test } from "bun:test";
import { DaemonBoundSessionExpiredError, DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_PREPARE_SESSION_METHOD,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
} from "../../src/daemon/sessionBrokerProxyAcquisition";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import type { SessionConfig } from "../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import type { DaemonClientLike } from "../../src/daemon/client";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const TOKEN = "broker-owner";
const SESSION = "11111111-2222-4333-8444-555555555555";
const config: SessionConfig = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "ios",
    hardware: { kind: "archetype", archetype: "phone" },
    os: { kind: "minimum", version: "18.0" },
  },
  preparationTimeoutMs: 20_000,
};
const ready: SessionBrokerResult = {
  contractVersion: 1,
  requestId: config.requestId,
  outcome: "ready",
  sessionUuid: SESSION,
  profile: {
    platform: "ios",
    metadataState: "current",
    simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    osVersion: "18.0",
  },
  cleanupPending: false,
};

const proxies: DaemonMcpProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

function setup(
  override?: (method: string, params: Record<string, unknown>, clientIndex: number) => unknown,
) {
  const timer = new FakeTimer();
  const clients: FakeDaemonClient[] = [];
  const makeClient = () => {
    const clientIndex = clients.length;
    const client = new FakeDaemonClient({
      onCallDaemonMethod: (method, params) => {
        const overridden = override?.(method, params, clientIndex);
        if (overridden !== undefined) {
          return overridden;
        }
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        if (method === DAEMON_PREPARE_SESSION_METHOD) {
          return ready;
        }
        if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
          return { sessionUuid: SESSION, outcome: "released" };
        }
        return {};
      },
      toolResult: { content: [{ type: "text", text: "ok" }] },
    });
    clients.push(client);
    return client;
  };
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    timer,
    clientFactory: makeClient,
    daemonManager: manager,
    daemonAvailabilityProbe: async () => true,
    autoStartDaemon: false,
    livenessOwnerToken: TOKEN,
  });
  proxies.push(proxy);
  return { proxy, clients, timer };
}

class AbortablePendingConnectClient extends FakeDaemonClient {
  readonly connectStarted = Promise.withResolvers<void>();
  connectSettled = false;

  override async connect(_timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    this.connectStarted.resolve();
    try {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("connect aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      });
    } finally {
      this.connectSettled = true;
    }
  }
}

describe("session broker proxy lifecycle", () => {
  test("clean close releases through the broker protocol only", async () => {
    const { proxy, clients } = setup();
    expect(await proxy.acquireBrokerSession(config)).toEqual(ready);
    expect(
      clients[0]!.callDaemonMethodCalls.find(({ method }) => method === DAEMON_HEARTBEAT_METHOD)
        ?.params,
    ).toMatchObject({
      sessionId: SESSION,
      livenessOwnerToken: TOKEN,
      claimLivenessOwnership: true,
    });

    await proxy.close();

    expect(
      clients
        .flatMap((client) => client.callDaemonMethodCalls)
        .filter(({ method }) => method === DAEMON_RELEASE_BROKER_SESSION_METHOD),
    ).toEqual([
      {
        method: DAEMON_RELEASE_BROKER_SESSION_METHOD,
        params: { sessionId: SESSION, livenessOwnerToken: TOKEN },
      },
    ]);
    expect(
      clients
        .flatMap((client) => client.callDaemonMethodCalls)
        .some(({ method }) => method === DAEMON_RELEASE_SESSION_METHOD),
    ).toBe(false);
  });

  test("an execution-owner-loss close reports session_owner_exited on the broker release (#12791)", async () => {
    const { proxy, clients } = setup((method) =>
      method === DAEMON_RELEASE_BROKER_SESSION_METHOD
        ? { sessionUuid: SESSION, outcome: "cleanup_pending" }
        : undefined,
    );
    expect(await proxy.acquireBrokerSession(config)).toEqual(ready);

    await proxy.close({ executionOwnerLost: true });

    expect(
      clients
        .flatMap((client) => client.callDaemonMethodCalls)
        .filter(({ method }) => method === DAEMON_RELEASE_BROKER_SESSION_METHOD),
    ).toEqual([
      {
        method: DAEMON_RELEASE_BROKER_SESSION_METHOD,
        params: { sessionId: SESSION, livenessOwnerToken: TOKEN, reason: "session_owner_exited" },
      },
    ]);
  });

  test("reconnect registers the exact durable receipt without private allocation keys", async () => {
    const { proxy, clients } = setup();
    await proxy.acquireBrokerSession(config);
    clients[0]!.emitConnectionClosed();
    await drainMicrotasks(32);

    await proxy.ensureConnected();

    const registration = clients[1]!.callDaemonMethodCalls.find(
      ({ method }) => method === DAEMON_REGISTER_SESSION_METHOD,
    );
    expect(registration?.params).toEqual({
      sessionId: SESSION,
      clientName: "auto-mobile-session-broker-proxy",
      sessionBroker: { requestId: "request-1", livenessOwnerToken: TOKEN },
    });
    expect(registration?.params).not.toHaveProperty("scopeKey");
    expect(registration?.params).not.toHaveProperty("bindingIndex");
  });

  test("a terminal release prevents stale reconnect but still requests durable cleanup", async () => {
    const { proxy, clients } = setup();
    await proxy.acquireBrokerSession(config);
    clients[0]!.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      SESSION,
      "heartbeat-timeout",
    );
    await expect(proxy.listAdvertisedTools()).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );
    clients[0]!.emitConnectionClosed();
    await drainMicrotasks(32);

    await proxy.ensureConnected();
    expect(
      clients[1]!.callDaemonMethodCalls.some(
        ({ method }) => method === DAEMON_REGISTER_SESSION_METHOD,
      ),
    ).toBe(false);

    await proxy.close();
    expect(
      clients[1]!.callDaemonMethodCalls.some(
        ({ method, params }) =>
          method === DAEMON_RELEASE_BROKER_SESSION_METHOD && params.sessionId === SESSION,
      ),
    ).toBe(true);
  });

  test("close aborts and joins broker acquisition connection work", async () => {
    const timer = new FakeTimer();
    const client = new AbortablePendingConnectClient();
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const proxy = new DaemonMcpProxy({
      timer,
      clientFactory: () => client as DaemonClientLike,
      daemonManager: manager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      livenessOwnerToken: TOKEN,
    });
    proxies.push(proxy);

    const acquisition = proxy.acquireBrokerSession(config);
    await client.connectStarted.promise;
    await proxy.close();

    expect(client.connectSettled).toBe(true);
    expect(client.isConnected()).toBe(false);
    expect(await acquisition).toMatchObject({
      requestId: config.requestId,
      outcome: "failed",
      failure: { code: "cancelled" },
    });
  });

  function parkedFirstHeartbeat() {
    const heartbeat = Promise.withResolvers<unknown>();
    let parked = false;
    const rig = setup((method) => {
      if (method === DAEMON_HEARTBEAT_METHOD && !parked) {
        parked = true;
        return heartbeat.promise;
      }
      return undefined;
    });
    const brokerReleases = () =>
      rig.clients
        .flatMap((client) => client.callDaemonMethodCalls)
        .filter(({ method }) => method === DAEMON_RELEASE_BROKER_SESSION_METHOD);
    return { ...rig, heartbeat, brokerReleases };
  }

  function track(acquisition: Promise<SessionBrokerResult>) {
    const state: { result?: SessionBrokerResult } = {};
    void acquisition.then((result) => {
      state.result = result;
    });
    return state;
  }

  test("a stalled first ownership heartbeat settles at the preparation deadline (#12770)", async () => {
    const { proxy, heartbeat, brokerReleases, timer } = parkedFirstHeartbeat();
    const acquisition = track(proxy.acquireBrokerSession(config));
    await drainMicrotasks(64);
    expect(acquisition.result).toBeUndefined();

    timer.advanceTime(config.preparationTimeoutMs! + 1);
    await drainMicrotasks(64);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { code: "timeout" },
    });
    expect(brokerReleases().length).toBeGreaterThan(0);

    heartbeat.resolve({});
    await drainMicrotasks(64);
    expect(proxy.getSessionBrokerResult()?.outcome).toBe("failed");
  });

  test("close settles a stalled first ownership heartbeat without storing ready (#12770)", async () => {
    const { proxy, heartbeat, brokerReleases } = parkedFirstHeartbeat();
    const acquisition = track(proxy.acquireBrokerSession(config));
    await drainMicrotasks(64);
    expect(acquisition.result).toBeUndefined();

    const closing = proxy.close();
    await drainMicrotasks(64);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { code: "cancelled" },
    });
    expect(brokerReleases().length).toBeGreaterThan(0);

    heartbeat.resolve({});
    await closing;
    await drainMicrotasks(64);
    expect(proxy.getSessionBrokerResult()?.outcome).toBe("failed");
  });

  test("terminal release evidence during the first ownership heartbeat fences ready (#12770)", async () => {
    const { proxy, clients, heartbeat, brokerReleases } = parkedFirstHeartbeat();
    const acquisition = track(proxy.acquireBrokerSession(config));
    await drainMicrotasks(64);

    clients[0]!.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      SESSION,
      "heartbeat-timeout",
    );
    heartbeat.resolve({});
    await drainMicrotasks(64);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { code: "session_hold_failed" },
    });
    expect(brokerReleases().length).toBeGreaterThan(0);
  });

  test("terminal reconnect refusal fences broker tools and is never retried", async () => {
    const lost = Object.assign(new Error("request no longer grants this session"), {
      code: "session_ownership_lost",
    });
    const { proxy, clients } = setup((method, _params, clientIndex) => {
      if (clientIndex > 0 && method === DAEMON_REGISTER_SESSION_METHOD) {
        throw lost;
      }
      return undefined;
    });
    await proxy.acquireBrokerSession(config);
    clients[0]!.emitConnectionClosed();
    await drainMicrotasks(32);

    await proxy.ensureConnected();

    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: SESSION,
      reason: "session_ownership_lost",
    });
    await expect(proxy.listAdvertisedTools()).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );
    await expect(proxy.callTool("getAndroid", {})).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );

    clients[1]!.emitConnectionClosed();
    await drainMicrotasks(32);
    await proxy.ensureConnected();
    expect(
      clients[2]!.callDaemonMethodCalls.some(
        ({ method }) => method === DAEMON_REGISTER_SESSION_METHOD,
      ),
    ).toBe(false);
  });
});
