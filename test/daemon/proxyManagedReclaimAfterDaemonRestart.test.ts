import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "../../src/daemon/client";
import {
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { livenessBudgetMs, type LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "managed-owner";
const LEASE = 4_000;
const INTERVAL = 2_000;
const RELEASE_REASON = "rehydration-owner-timeout";
const extra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error("Unexpected client request");
  },
};

/** Real heartbeat ingress and lease monitor, with a replaceable in-memory daemon and socket. */
class RestartScenario {
  readonly timer = new FakeTimer();
  readonly daemonManager = new FakeDaemonManager();
  readonly clients: FakeDaemonClient[] = [];
  readonly dials: number[] = [];
  readonly heartbeats: Array<{ at: number; params: Record<string, unknown> }> = [];
  readonly handovers: Array<{ at: number; handover: LivenessHandover }> = [];
  readonly reaped: string[] = [];
  readonly managers: SessionManager[] = [];
  readonly proxy: DaemonMcpProxy;
  manager!: SessionManager;
  monitor!: SessionHeartbeatMonitor;
  available = true;
  releasePushOnSubscribe = false;
  instance = "old-daemon";

  constructor() {
    this.daemonManager.statusResult = {
      ...this.daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    this.proxy = new DaemonMcpProxy({
      clientFactory: () => this.client(),
      daemonManager: this.daemonManager,
      autoStartDaemon: false,
      timer: this.timer,
      idGenerator: new FakeIdGenerator([TOKEN]),
      heartbeatTimeoutMs: LEASE,
      heartbeatIntervalMs: INTERVAL,
    });
    this.proxy.onLivenessHandover((handover) =>
      this.handovers.push({ at: this.timer.now(), handover }),
    );
  }

  async start(): Promise<void> {
    await this.newDaemon(true);
    const result = await this.proxy.acquireManagedSlots({
      contractVersion: 1,
      managedHostScope: "host",
      runnerNamespace: "runner",
      runnerIncarnation: "boot",
      localSlotCapacity: 1,
      requests: [
        {
          slotIndex: 1,
          role: "primary",
          platform: "android",
          requestedSpec: { runtime: "system-images;android-35;google_apis;arm64-v8a" },
        },
      ],
    });
    expect(result.outcome).toBe("ready");
  }

  private async newDaemon(withSession: boolean): Promise<void> {
    this.manager = new SessionManager(this.timer, new FakeDeviceSessionPersistence());
    this.managers.push(this.manager);
    this.manager.stopCleanupTimer();
    if (withSession) {
      await this.rehydrate();
    }
    this.monitor = new SessionHeartbeatMonitor(
      this.manager,
      () => false,
      async (sessionId, reason) => {
        this.reaped.push(reason);
        await this.manager.releaseSession(sessionId, reason);
        this.clients
          .at(-1)
          ?.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, sessionId, reason);
      },
      this.timer,
      { checkIntervalMs: INTERVAL },
    );
    this.monitor.start();
  }

  async rehydrate(): Promise<void> {
    const session = await this.manager.createSession(
      SESSION,
      "emulator-5554",
      "android",
      600_000,
      LEASE,
    );
    await this.manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 600_000 });
    // The successor's persisted session is awaiting its owner, exactly as after rehydration.
    session.ownership = "awaiting-owner";
    session.awaitingOwnerSince = this.timer.now();
  }

  private state(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getDaemonInstance: () => this.instance,
      getSessionManager: () => this.manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    } as DaemonStateAccess;
  }

  private client(): FakeDaemonClient {
    this.dials.push(this.timer.now());
    const client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([
        ["tools/list", { tools: [] }],
        ["daemon/capabilities", { capabilities: ["managed-slots/v1"] }],
        [DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD, readyManagedSlotsResult(SESSION)],
      ]),
      toolResultFor: (_name, params) => ({
        content: [{ type: "text", text: JSON.stringify({ observed: params.sessionUuid }) }],
      }),
      onCallDaemonMethod: async (method, params) => {
        if (method !== DAEMON_HEARTBEAT_METHOD) {
          return undefined;
        }
        this.heartbeats.push({ at: this.timer.now(), params });
        const response = await handleDaemonRequest(
          { id: "heartbeat", type: "daemon_request", method, params },
          this.state(),
        );
        if (!response.success) {
          // Preserve the daemon's refusal fields, especially releaseReason, across the fake socket.
          throw Object.assign(new Error(response.error), response);
        }
        return response.result;
      },
    });
    client.shouldFailConnect = !this.available;
    const subscribe = client.subscribeToNotifications.bind(client);
    client.subscribeToNotifications = async () => {
      await subscribe();
      if (this.releasePushOnSubscribe) {
        this.releasePushOnSubscribe = false;
        client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, SESSION, RELEASE_REASON);
      }
    };
    this.clients.push(client);
    return client;
  }

  async stop(clean: boolean): Promise<void> {
    if (clean) {
      this.clients
        .at(-1)!
        .emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, SESSION, "daemon-shutdown");
    }
    this.available = false;
    this.clients.at(-1)!.emitConnectionClosed();
    await this.monitor.stop();
  }

  async restart(withSession = true): Promise<void> {
    this.instance = "replacement-daemon";
    await this.newDaemon(withSession);
    this.available = true;
  }

  async advance(ms: number): Promise<void> {
    await this.timer.advanceTimeAsync(ms, () => drainUntilQuiescent(this.timer));
  }

  async close(): Promise<void> {
    await this.proxy.close();
    await this.monitor.stop();
    for (const manager of this.managers) {
      manager.stopCleanupTimer();
    }
  }
}

let s: RestartScenario;
let spies: Array<ReturnType<typeof spyOn>>;

// Pay only the server's one-time schema/registry initialization outside timed scenarios.
beforeAll(async () => {
  const proxy = new DaemonMcpProxy({
    clientFactory: () => new FakeDaemonClient(),
    daemonManager: new FakeDaemonManager(),
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(),
    autoStartDaemon: false,
  });
  const { server } = createProxyMcpServer({
    proxy,
    managedSlots: readyManagedSlotsResult(SESSION),
  });
  await server.close();
  await proxy.close();
});

beforeEach(() => {
  s = new RestartScenario();
  spies = [
    // Reachability is modeled by connect(), including a cheap availability check racing EOF.
    spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
    ...(["info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    ),
  ];
});
afterEach(async () => {
  await s.close();
  for (const spy of spies) {
    spy.mockRestore();
  }
});

function parsed(result: unknown): Array<{
  warning?: { code: string };
  error?: { code: string; reason: string };
  observed?: string;
}> {
  return (result as { content: Array<{ text: string }> }).content.map(({ text }) =>
    JSON.parse(text),
  );
}

async function handedOver(clean = true): Promise<void> {
  await s.start();
  await s.stop(clean);
  await s.advance(20_000);
  expect(s.handovers.map(({ handover }) => handover.code)).toEqual(["daemon_stalled"]);
  const { at, handover } = s.handovers[0];
  expect(handover.attempts).toBe(3);
  expect(at - handover.lastAcknowledgedHeartbeatAt).toBeLessThanOrEqual(livenessBudgetMs(LEASE));
}

test("PIN: clean stop with a 3 s gap reclaims inside recovery", async () => {
  await s.start();
  await s.stop(true);
  await s.advance(3_000);
  await s.restart();
  await s.advance(INTERVAL * 2);
  expect(s.manager.getSession(SESSION)?.livenessOwnerToken).toBe(TOKEN);
  expect(parsed(await s.proxy.callTool("observe", {}))[0].observed).toBe(SESSION);
  expect(s.handovers).toEqual([]);
});

test.each(["clean", "kill"] as const)(
  "%s: a 20 s restart is reclaimed within one keeper interval",
  async (kind) => {
    const clean = kind === "clean";
    await handedOver(clean);
    await s.restart();
    const returnedAt = s.timer.now();
    await s.advance(INTERVAL);
    const claim = s.heartbeats.find(
      ({ at, params }) =>
        at >= returnedAt &&
        params.claimLivenessOwnership === true &&
        params.expectedDaemonInstance === undefined,
    );
    expect(claim).toBeDefined();
    expect(claim!.at - returnedAt).toBeLessThanOrEqual(INTERVAL);
    expect(claim!.params.livenessOwnerToken).toBe(TOKEN);
    expect(s.proxy.getManagedExecutionSessions()).toEqual([SESSION]);
    await s.advance(LEASE * 5);
    expect(s.reaped).toEqual([]);
    expect(s.manager.getSession(SESSION)?.ownership).toBe("owned");
    const result = parsed(await s.proxy.callTool("observe", {}));
    expect(result[0].observed).toBe(SESSION);
    expect(result.filter((entry) => entry.warning).map((entry) => entry.warning!.code)).toEqual([
      "daemon_restart_resumed",
    ]);
    expect(parsed(await s.proxy.callTool("observe", {})).filter((entry) => entry.warning)).toEqual(
      [],
    );
    expect(s.handovers.map(({ handover }) => handover.code)).toEqual(["daemon_stalled"]);
  },
);

test("PIN: an absent daemon keeps a constant probe cadence and typed handover until close", async () => {
  await handedOver();
  const start = s.timer.now();
  const counts: number[] = [];
  for (let round = 0; round < 3; round++) {
    const before = s.dials.length;
    await s.advance(INTERVAL * 10);
    counts.push(s.dials.length - before);
    await expect(s.proxy.callTool("observe", {})).rejects.toMatchObject({
      handover: { code: "daemon_stalled" },
    });
  }
  expect(counts).toEqual([10, 10, 10]);
  const dials = s.dials.filter((at) => at > start);
  expect(dials.slice(1).map((at, index) => at - dials[index])).toEqual(
    Array(dials.length - 1).fill(INTERVAL),
  );
  expect(s.handovers.map(({ handover }) => handover.code)).toEqual(["daemon_stalled"]);
  expect(s.daemonManager.startCallCount).toBe(0);
  expect(s.daemonManager.restartCallCount).toBe(0);
  await s.close();
  expect(s.timer.getPendingIntervalCount()).toBe(0);
  expect(s.timer.getPendingTimeoutCount()).toBe(0);
  expect(s.timer.getPendingSleepCount()).toBe(0);
});

test.each(["notification", "heartbeat"] as const)(
  "one daemon release reason via %s reaches every managed surface",
  async (via) => {
    const registration = spyOn(Server.prototype, "setRequestHandler");
    const { server } = createProxyMcpServer({
      proxy: s.proxy,
      managedSlots: readyManagedSlotsResult(SESSION),
    });
    const call = registration.mock.calls.find(([schema]) => schema === CallToolRequestSchema)![1];
    const read = registration.mock.calls.find(
      ([schema]) => schema === ReadResourceRequestSchema,
    )![1];
    registration.mockRestore();
    const logged = spyOn(Server.prototype, "sendLoggingMessage").mockResolvedValue(undefined);
    spies.push(logged);
    try {
      await handedOver();
      await s.restart();
      await s.manager.releaseSession(SESSION, RELEASE_REASON);
      if (via === "notification") {
        // The successor pushes its already-recorded release as the new socket subscribes.
        s.releasePushOnSubscribe = true;
      }
      await s.advance(INTERVAL * 2);
      const request = { method: "tools/call", params: { name: "observe", arguments: {} } };
      for (let callNumber = 0; callNumber < 2; callNumber++) {
        expect(parsed(await call(request, extra))[0].error).toMatchObject({
          code: "managed_execution_ended",
          reason: RELEASE_REASON,
        });
      }
      expect(s.proxy.getTerminalSessionRelease()?.reason).toBe(RELEASE_REASON);
      const resource = await read(
        { method: "resources/read", params: { uri: "automobile:managed-slots" } },
        extra,
      );
      expect(JSON.parse(resource.contents[0].text).slots[0].executionEnded.reason).toBe(
        RELEASE_REASON,
      );
      const losses = logged.mock.calls
        .map(([params]) => params.data)
        .filter(
          (data) => (data as { error: { code: string } }).error.code === "managed_execution_ended",
        );
      expect(losses).toHaveLength(1);
      expect(losses[0]).toMatchObject({ error: { reason: RELEASE_REASON } });
      expect(JSON.stringify(losses)).not.toContain("proxy_stalled");
      expect(JSON.stringify(losses)).not.toContain("session-not-found");
    } finally {
      await server.close();
    }
  },
);

test("reasonless not-found during successor rehydration is reclaimed inside the existing window", async () => {
  await handedOver();
  await s.restart(false);
  await s.advance(INTERVAL * 2);
  expect(s.handovers.map(({ handover }) => handover.code)).toEqual(["daemon_stalled"]);
  await s.rehydrate();
  await s.advance(INTERVAL);
  expect(s.manager.getSession(SESSION)?.livenessOwnerToken).toBe(TOKEN);
  expect(parsed(await s.proxy.callTool("observe", {}))[0].observed).toBe(SESSION);
});

test("reasonless not-found stops reclaiming at the existing window and delivers one loss", async () => {
  await handedOver();
  await s.restart(false);
  const returnedAt = s.timer.now();
  await s.advance(INTERVAL);
  const firstAnswerAt = s.heartbeats.find(({ at }) => at >= returnedAt)!.at;
  await s.advance(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS - 1);
  expect(s.handovers.map(({ handover }) => handover.code)).toEqual(["daemon_stalled"]);
  await s.advance(INTERVAL + 1);
  expect(s.handovers.map(({ handover }) => handover.code)).toEqual([
    "daemon_stalled",
    "proxy_stalled",
  ]);
  expect(s.handovers[1].at - firstAnswerAt).toBeGreaterThanOrEqual(
    RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  );
  const count = s.heartbeats.length;
  await s.advance(INTERVAL * 4);
  expect(s.heartbeats).toHaveLength(count);
  expect(s.timer.getPendingIntervals()).toEqual([INTERVAL]); // Only the daemon monitor remains.
  await expect(s.proxy.callTool("observe", {})).rejects.toMatchObject({
    handover: { code: "proxy_stalled" },
  });
  expect(s.proxy.getTerminalSessionRelease()?.reason).toBe("session-not-found");
});
