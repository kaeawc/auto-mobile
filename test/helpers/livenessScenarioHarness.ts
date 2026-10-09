import { spyOn } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_VERSION,
  getCliSessionIdleTimeoutMs,
} from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/sessionLivenessWindows";
import {
  SessionManager,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../../src/daemon/sessionManager";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import { executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "./devicePoolDependencies";
import { drainMicrotasks } from "./fakeTimerStepping";
import { RealToolCallPath, type DeviceToolRun } from "./realToolCallPath";

// Two-sided liveness scenario harness (#10667, umbrella #10655).
//
// Every "kept while X" assertion is paired with a "released when Y" assertion on the same
// scenario, driven by the real producers rather than by hand-called SessionManager probes.
//
// Real: DaemonMcpProxy built like src/index.ts (its own keeper heartbeats at the production
// cadence and owner token), handleDaemonRequest, SessionManager and its cleanup sweep,
// SessionHeartbeatMonitor wired as in daemon.ts, DevicePool (including OwnerDisconnectRelease),
// releaseSessionAndDevice, and rehydration across a simulated daemon restart. A device tool
// call runs the real registration through the real ToolRegistry, session admission and execution
// tracker, and its end reaches the session through the daemon's own
// `subscribeToolCallEndActivity` (#10839; see RealToolCallPath).
// Faked: the socket transport (each frame is handed to the real handler), the tool body's device
// work, device discovery and readiness, persistence, and the clock (FakeTimer).
//
// A scenario covers minutes of virtual time in a few milliseconds by advancing in coarse steps;
// the keeper still ticks every production interval inside each step.

export const KEEPER_INTERVAL_MS = PROXY_HEARTBEAT_INTERVAL_MS;
export const IDLE_WINDOW_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
export const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
export const NO_HEARTBEAT_BUDGET_MS = NO_HEARTBEAT_RELEASE_BUDGET_MS;
/** The latest an idle release lands after its deadline: suspect grace, one scan, one keeper tick. */
export const RELEASE_SLACK_MS = SUSPECT_GRACE_MS + SCAN_MS + KEEPER_INTERVAL_MS;
/** The autolock window the scenarios configure (AUTOMOBILE_DEVICE_POOL_TIMEOUT, in seconds). */
/** A JUnit runner heartbeats its session every second (android/junit-runner DaemonHeartbeat.kt). */
export const JUNIT_HEARTBEAT_MS = 1_000;
export const AUTOLOCK_WINDOW_MS = 60_000;

/** Microtask turns per fake-timer event so a keeper round trip settles before the next tick. */
const TURNS_PER_EVENT = 32;
const CONNECTION = "scenario-connection";
export const OWNER_TOKEN = "scenario-proxy-owner";
const PLATFORM = "android" as const;

export interface ReleaseRecord {
  at: number;
  sessionId: string;
  deviceId: string;
  reason: string;
}

export interface PoolTimelineEntry {
  status: string;
  sessionId: string | null;
  autolockSessionId: string | undefined;
}

export interface LivenessScenarioOptions {
  /** Device ids in the pool; the first is the default acquisition target. */
  devices?: string[];
  /** Autolock acquisition with the 60 s window (AUTOMOBILE_DEVICE_POOL_AUTOLOCK). */
  autolock?: boolean;
}

interface DaemonSide {
  manager: SessionManager;
  pool: DevicePool;
  monitor: SessionHeartbeatMonitor;
  state: DaemonStateAccess;
  unsubscribeToolCallEnd: () => void;
}

interface LongCall {
  /** The tool call settles now. */
  settle(): Promise<void>;
  done: Promise<unknown>;
}

function deviceStartResult(sessionUuid: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

/** provisionDevice's shape: the description nests under `device` beside a top-level `sessionId`. */
function provisionDeviceResult(sessionUuid: string, deviceId: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          device: { name: `Pixel_${deviceId}`, platform: PLATFORM, runtime: { deviceId } },
          sessionId: sessionUuid,
          source: "created",
        }),
      },
    ],
  };
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
] as const;

export class LivenessScenario {
  readonly timer = new FakeTimer();
  readonly persistence = new FakeDeviceSessionPersistence();
  readonly releases: ReleaseRecord[] = [];
  readonly reaped: Array<{ sessionId: string; reason: string }> = [];
  readonly deviceIds: string[];
  /** Heartbeat frames the proxy keepers delivered, by session. */
  readonly heartbeatsBySession = new Map<string, number>();
  /** Heartbeat frames delivered, by owner token. */
  readonly heartbeatsByToken = new Map<string, number>();
  /** While true, the transport silently loses every heartbeat frame (the proxy sees an ack). */
  dropHeartbeats = false;
  daemon!: DaemonSide;
  proxy!: DaemonMcpProxy;
  private readonly autolock: boolean;
  private readonly discovery = new FakeDeviceUtils();
  private tools!: RealToolCallPath;
  private readonly spies: Array<ReturnType<typeof spyOn>> = [];
  private readonly savedEnv = new Map<string, string | undefined>();
  private readonly gates = new Map<string, Promise<void>>();
  private minted: string | undefined;
  private mintCount = 0;

  private constructor(options: LivenessScenarioOptions) {
    this.deviceIds = options.devices ?? ["emulator-5554"];
    this.autolock = options.autolock ?? false;
  }

  static async start(options: LivenessScenarioOptions = {}): Promise<LivenessScenario> {
    const scenario = new LivenessScenario(options);
    await scenario.boot();
    return scenario;
  }

  private device(deviceId: string) {
    return { deviceId, name: `Pixel_${deviceId}`, platform: PLATFORM };
  }

  private async boot(): Promise<void> {
    this.spies.push(
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    );
    for (const key of AUTOLOCK_ENV_KEYS) {
      this.savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    if (this.autolock) {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = String(AUTOLOCK_WINDOW_MS / 1000);
    }
    this.discovery.setBootedDevices(
      PLATFORM,
      this.deviceIds.map((id) => this.device(id)),
    );
    this.tools = new RealToolCallPath(this.deviceIds.map((id) => this.device(id))).install();
    // A long call stays in flight at the device boundary until the scenario settles it.
    this.tools.setBody(async (input) => {
      await this.gates.get(input.args?.sessionUuid);
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    });
    this.daemon = await this.createDaemonSide();
    this.proxy = this.createProxy();
  }

  /** A second stdio proxy on the same daemon, e.g. a challenger naming another proxy's session. */
  addProxy(config: { token: string; initialSessionUuid?: string }): DaemonMcpProxy {
    return this.createProxy(config.token, config.initialSessionUuid);
  }

  /** One daemon process: its session manager, pool and heartbeat monitor over shared persistence. */
  private async createDaemonSide(): Promise<DaemonSide> {
    const manager = new SessionManager(
      this.timer,
      this.persistence,
      () => new FakeDbWriteBarrier(),
    );
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "scenario-daemon", {
        timer: this.timer,
        deviceManager: this.discovery,
        env: { ...process.env },
      }),
    );
    await pool.initializeWithDevices(this.deviceIds.map((id) => this.device(id)));
    const registry = new DeviceSessionRegistry(this.timer);
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => registry,
    };
    // ToolRegistry resolves sessions through the process singleton, as in the daemon.
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    DaemonState.getInstance().initialize(manager, pool, registry);
    // The daemon's own wiring: in-flight calls veto releases, and a call's END is activity.
    const inFlight = (sessionId: string) =>
      hasActiveSessionExecution(executionTracker, manager, pool, sessionId);
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, manager, pool, sessionId, query),
    );
    const unsubscribeToolCallEnd = subscribeToolCallEndActivity(executionTracker, manager, pool);
    manager.onSessionRelease((sessionId, deviceId, reason) => {
      this.releases.push({ at: this.timer.now(), sessionId, deviceId, reason: reason ?? "" });
    });
    const monitor = new SessionHeartbeatMonitor(
      manager,
      inFlight,
      async (sessionId, reason) => {
        this.reaped.push({ sessionId, reason });
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      this.timer,
    );
    monitor.start();
    return { manager, pool, monitor, state, unsubscribeToolCallEnd };
  }

  /** The stdio proxy exactly as src/index.ts builds it: default lease, owner token, own keeper. */
  private createProxy(token = OWNER_TOKEN, initialSessionUuid?: string): DaemonMcpProxy {
    const client = new FakeDaemonClient({
      onCallTool: (tool, params) => this.runDeviceTool(tool, params),
      toolResultFor: (tool, params) => {
        if (!this.minted) {
          return undefined;
        }
        if (tool === "provisionDevice") {
          return provisionDeviceResult(this.minted, String(params.deviceId));
        }
        return tool === "getAndroid" ? deviceStartResult(this.minted) : undefined;
      },
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        if (this.dropHeartbeats) {
          return;
        }
        const response = await this.daemonMethod(method, params);
        if (typeof params.livenessOwnerToken === "string") {
          this.heartbeatsByToken.set(
            params.livenessOwnerToken,
            (this.heartbeatsByToken.get(params.livenessOwnerToken) ?? 0) + 1,
          );
        }
        if (typeof params.sessionId === "string") {
          this.heartbeatsBySession.set(
            params.sessionId,
            (this.heartbeatsBySession.get(params.sessionId) ?? 0) + 1,
          );
        }
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
    return new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: this.timer,
      idGenerator: new FakeIdGenerator(),
      livenessOwnerToken: token,
      heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
      ...(initialSessionUuid ? { initialSessionUuid } : {}),
    });
  }

  /**
   * A tool call as the daemon runs it behind the socket. `getAndroid` acquires through the pool
   * directly (its readiness setup is the device boundary); every other tool runs the real
   * registration through the real ToolRegistry path.
   */
  private async runDeviceTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
    const { manager, pool } = this.daemon;
    if (tool === "getAndroid" || tool === "provisionDevice") {
      const deviceId = typeof params.deviceId === "string" ? params.deviceId : this.deviceIds[0]!;
      if (this.autolock && tool === "getAndroid") {
        this.minted = await pool.autolockDevice(deviceId, PLATFORM, CONNECTION);
      } else {
        this.minted = `scenario-session-${++this.mintCount}`;
        await pool.bindOrReuseDeviceSession(
          this.minted,
          deviceId,
          PLATFORM,
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          CONNECTION,
        );
      }
      // Acquisition prepared the device, as getAndroid's readiness setup records.
      manager.setDeviceReadiness(this.minted, "automationReady");
      return undefined;
    }
    return await this.tools.call(tool, this.resolveSelectorRoute(params));
  }

  /**
   * The daemon resolves a selector-routed call (`deviceId`/`platform`, no `sessionUuid`) to one of
   * the sessions the proxy says it owns before the tool runs (`DAEMON_OWNED_SESSIONS_PARAM`). This
   * stands in for that resolution, which lives in the socket server: it picks the owned session
   * bound to the selected device (or platform) and drops the proxy's routing marker.
   */
  private resolveSelectorRoute(params: Record<string, unknown>): Record<string, unknown> {
    const { [DAEMON_OWNED_SESSIONS_PARAM]: owned, ...rest } = params;
    if (rest.sessionUuid !== undefined || !Array.isArray(owned)) {
      return rest;
    }
    const sessions = owned.flatMap((id) => {
      const session = typeof id === "string" ? this.daemon.manager.getSession(id) : null;
      return session ? [session] : [];
    });
    const reached = sessions.find((session) =>
      typeof rest.deviceId === "string"
        ? session.assignedDevice === rest.deviceId
        : session.platform === rest.platform,
    );
    return reached ? { ...rest, sessionUuid: reached.sessionId } : rest;
  }

  daemonMethod(method: string, params: Record<string, unknown> = {}) {
    return handleDaemonRequest(
      { id: method, type: "daemon_request", method, params },
      this.daemon.state,
    );
  }

  // ---- events -------------------------------------------------------------------------------

  /** Advance virtual time, letting each due event's async work (a keeper round trip) settle. */
  async idle(ms: number): Promise<void> {
    await this.timer.advanceTimeAsync(ms, () => drainMicrotasks(TURNS_PER_EVENT));
  }

  /** The agent's getAndroid: acquires `deviceId` and returns the session UUID the daemon minted. */
  async acquire(deviceId: string = this.deviceIds[0]!): Promise<string> {
    await this.proxy.callTool("getAndroid", { deviceId });
    await drainMicrotasks(TURNS_PER_EVENT);
    return this.minted!;
  }

  /**
   * A desktop/IDE client acquires a device itself over its own connection, with no owner token:
   * its session is held only by tokenless heartbeats ({@link startTokenlessHeartbeats}).
   */
  async acquireTokenless(deviceId: string = this.deviceIds[0]!): Promise<string> {
    const sessionId = `desktop-session-${++this.mintCount}`;
    await this.daemon.pool.bindOrReuseDeviceSession(
      sessionId,
      deviceId,
      PLATFORM,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "desktop-connection",
    );
    return sessionId;
  }

  /** A device tool call on `sessionId` that settles at once. */
  async toolCall(sessionId: string, tool = "observe"): Promise<void> {
    await this.proxy.callTool(tool, { sessionUuid: sessionId });
  }

  /**
   * A device tool call that reaches the daemon with no stdio proxy in front of it (a `--cli` call,
   * the desktop or a JUnit runner over the socket): the proxy's own released-session refusal does
   * not apply, so the daemon's admission decides.
   */
  async daemonToolCall(sessionId: string, tool = "observe"): Promise<unknown> {
    return await this.runDeviceTool(tool, { sessionUuid: sessionId });
  }

  /** A daemon-side tool call with exactly these arguments (no proxy in front, no routing markers). */
  async daemonToolCallWith(args: Record<string, unknown>, tool = "observe"): Promise<unknown> {
    return await this.runDeviceTool(tool, args);
  }

  /** A tool call that stays in flight until `settle()`. */
  startLongCall(sessionId: string, tool = "observe"): LongCall {
    let open!: () => void;
    this.gates.set(
      sessionId,
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const done = this.proxy.callTool(tool, { sessionUuid: sessionId });
    return {
      done,
      settle: async () => {
        open();
        this.gates.delete(sessionId);
        await done;
        await drainMicrotasks(TURNS_PER_EVENT);
      },
    };
  }

  /**
   * The host sleeps: the wall clock jumps, the monotonic clock stands still (#10699), and no timer
   * fires until the next advance.
   */
  hostSleep(ms: number): void {
    this.timer.simulateHostSleep(ms);
  }

  /**
   * A desktop/IDE tokenless client: it heartbeats `sessionId` with no owner token every
   * `cadenceMs` (the desktop loop's 2 s, DESKTOP_HEARTBEAT_MS in the wire contract) until
   * `stop()`. It binds nothing itself; it holds a session another actor made.
   */
  startTokenlessHeartbeats(sessionId: string, cadenceMs = 2_000): { stop(): void } {
    const handle = this.timer.setInterval(() => {
      void this.daemonMethod("daemon/heartbeat", { sessionId });
    }, cadenceMs);
    return { stop: () => this.timer.clearInterval(handle) };
  }

  /**
   * A `--daemon heartbeat` keeper (#10054, #6870): the first tick claims `token` and moves the
   * session to the `cli-idle` policy, later ticks prove the token. It is tokened liveness only,
   * never use: it must not restart the idle window.
   */
  startCliKeeper(
    sessionId: string,
    token = "cli-keeper-token",
    cadenceMs = 5_000,
  ): { stop(): void } {
    let claimed = false;
    const handle = this.timer.setInterval(() => {
      void this.daemonMethod("daemon/heartbeat", {
        sessionId,
        livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
        livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
        idleTimeoutMs: getCliSessionIdleTimeoutMs(),
        livenessOwnerToken: token,
        ...(claimed ? {} : { claimLivenessOwnership: true }),
      });
      claimed = true;
    }, cadenceMs);
    return { stop: () => this.timer.clearInterval(handle) };
  }

  /**
   * A JUnit runner's HTTP heartbeat loop: tokenless beats every second (DEFAULT_INTERVAL_MS in
   * `DaemonHeartbeat.kt`) for the session under test, alongside its own tool calls
   * ({@link daemonToolCall}).
   */
  startJunitHeartbeats(sessionId: string): { stop(): void } {
    return this.startTokenlessHeartbeats(sessionId, JUNIT_HEARTBEAT_MS);
  }

  /** A device tool call the agent routes by `deviceId`, with no session UUID. */
  async selectorCall(deviceId: string, tool = "observe"): Promise<void> {
    await this.proxy.callTool(tool, { deviceId });
  }

  /**
   * An agent acquires through `provisionDevice` (result shape `{device, sessionId}`) instead of
   * `getAndroid`, returning the session UUID the daemon minted.
   */
  async provision(deviceId: string = this.deviceIds[0]!): Promise<string> {
    await this.proxy.callTool("provisionDevice", { deviceId });
    await drainMicrotasks(TURNS_PER_EVENT);
    return this.minted!;
  }

  /** Tool bodies that reached the device boundary (what actually drove a device). */
  get driven(): readonly DeviceToolRun[] {
    return this.tools.runs;
  }

  /** The MCP host closes the proxy's stdin: the keeper stops and the connection drops. */
  async closeTransport(): Promise<void> {
    await this.proxy.close();
    this.daemon.pool.releaseMcpSessionBindings(CONNECTION);
  }

  /**
   * The daemon process restarts: its in-memory state is gone, active rows are persisted as
   * released-for-restart, and the new process rehydrates them awaiting their owners. The
   * proxy, if still running, keeps heartbeating the new process.
   */
  async daemonRestart(): Promise<void> {
    const old = this.daemon;
    for (const session of old.manager.getAllSessions()) {
      await this.persistence.markReleased(
        session.sessionId,
        "expired",
        this.timer.now(),
        "daemon-restart",
      );
    }
    await old.monitor.stop();
    old.manager.stopCleanupTimer();
    old.unsubscribeToolCallEnd();
    this.daemon = await this.createDaemonSide();
    await this.daemon.manager.rehydratePersistedSessions(this.daemon.pool);
    this.daemon.manager.startRehydratedOwnerWindows();
  }

  async stop(): Promise<void> {
    await this.proxy.close();
    await this.daemon.monitor.stop();
    this.daemon.manager.stopCleanupTimer();
    this.daemon.unsubscribeToolCallEnd();
    this.tools.uninstall();
    DaemonState.getInstance().reset();
    for (const spy of this.spies.splice(0)) {
      spy.mockRestore();
    }
    for (const [key, value] of this.savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  // ---- observations ---------------------------------------------------------------------------

  /** The pool's view of one device: the timeline entry the matrix asserts on. */
  poolState(deviceId: string = this.deviceIds[0]!): PoolTimelineEntry {
    const device = this.daemon.pool.getDevice(deviceId);
    return {
      status: device?.status ?? "missing",
      sessionId: device?.sessionId ?? null,
      autolockSessionId: device?.autolockSessionId,
    };
  }

  isHeld(sessionId: string): boolean {
    return this.daemon.manager.getSession(sessionId) !== null;
  }

  releaseOf(sessionId: string): ReleaseRecord | undefined {
    return this.releases.find((release) => release.sessionId === sessionId);
  }

  /**
   * Advance in `stepMs` steps until `sessionId` is released or `limitMs` passes. Returns the
   * virtual time of the release, or undefined if it was still held at the limit. Asserting on
   * the returned time is how a scenario bounds "released when Y".
   */
  async idleUntilReleased(
    sessionId: string,
    limitMs: number,
    stepMs = KEEPER_INTERVAL_MS,
  ): Promise<number | undefined> {
    const deadline = this.timer.now() + limitMs;
    while (this.timer.now() < deadline) {
      await this.idle(Math.min(stepMs, deadline - this.timer.now()));
      await drainMicrotasks(TURNS_PER_EVENT);
      if (!this.isHeld(sessionId)) {
        return this.timer.now();
      }
    }
    return undefined;
  }

  /** Advance to `untilMs` (absolute) in `stepMs` steps, returning the first time `sessionId` was not held. */
  async idleWhileHeld(
    sessionId: string,
    untilMs: number,
    stepMs = 10_000,
  ): Promise<number | undefined> {
    while (this.timer.now() < untilMs) {
      await this.idle(Math.min(stepMs, untilMs - this.timer.now()));
      if (!this.isHeld(sessionId)) {
        return this.timer.now();
      }
    }
    return undefined;
  }
}
