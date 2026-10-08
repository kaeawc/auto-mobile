import { spyOn } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
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

// Two-sided liveness scenario harness (#10667, umbrella #10655).
//
// Every "kept while X" assertion is paired with a "released when Y" assertion on the same
// scenario, driven by the real producers rather than by hand-called SessionManager probes.
//
// Real: DaemonMcpProxy built like src/index.ts (its own keeper heartbeats at the production
// cadence and owner token), handleDaemonRequest, SessionManager and its cleanup sweep,
// SessionHeartbeatMonitor wired as in daemon.ts, DevicePool (including OwnerDisconnectRelease),
// releaseSessionAndDevice, and rehydration across a simulated daemon restart.
// Faked: the socket transport (each frame is handed to the real handler), the device tool body,
// device discovery, persistence, and the clock (FakeTimer).
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
  readonly inFlight = new Set<string>();
  daemon!: DaemonSide;
  proxy!: DaemonMcpProxy;
  private readonly autolock: boolean;
  private readonly discovery = new FakeDeviceUtils();
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
    manager.setActiveSessionExecutionChecker((sessionId) => this.inFlight.has(sessionId));
    manager.onSessionRelease((sessionId, deviceId, reason) => {
      this.releases.push({ at: this.timer.now(), sessionId, deviceId, reason: reason ?? "" });
    });
    const monitor = new SessionHeartbeatMonitor(
      manager,
      (sessionId) => this.inFlight.has(sessionId),
      async (sessionId, reason) => {
        this.reaped.push({ sessionId, reason });
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      this.timer,
    );
    monitor.start();
    return { manager, pool, monitor, state };
  }

  /** The stdio proxy exactly as src/index.ts builds it: default lease, owner token, own keeper. */
  private createProxy(token = OWNER_TOKEN, initialSessionUuid?: string): DaemonMcpProxy {
    const client = new FakeDaemonClient({
      onCallTool: (tool, params) => this.runDeviceTool(tool, params),
      toolResultFor: (tool) =>
        tool === "getAndroid" && this.minted ? deviceStartResult(this.minted) : undefined,
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

  /** The device tool body, as the daemon runs it behind the socket. */
  private async runDeviceTool(tool: string, params: Record<string, unknown>): Promise<void> {
    const { manager, pool } = this.daemon;
    if (tool === "getAndroid") {
      const deviceId = typeof params.deviceId === "string" ? params.deviceId : this.deviceIds[0]!;
      if (this.autolock) {
        this.minted = await pool.autolockDevice(deviceId, PLATFORM, CONNECTION);
        return;
      }
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
      return;
    }
    const sessionId = params.sessionUuid;
    if (typeof sessionId !== "string") {
      return;
    }
    // A tool call is activity from its start to its end, and is never released mid-call.
    this.inFlight.add(sessionId);
    try {
      await manager.getOrCreateSession(sessionId);
      await this.gates.get(sessionId);
    } finally {
      this.inFlight.delete(sessionId);
      manager.recordToolCallEnded(sessionId);
    }
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

  /** The host sleeps: the clock jumps and no timer fires until the next advance. */
  hostSleep(ms: number): void {
    this.timer.setCurrentTime(this.timer.now() + ms);
  }

  /**
   * A desktop/IDE tokenless client: it heartbeats `sessionId` with no owner token every
   * `cadenceMs` until `stop()`. It binds nothing itself; it holds a session another actor made.
   */
  startTokenlessHeartbeats(sessionId: string, cadenceMs = 5_000): { stop(): void } {
    const handle = this.timer.setInterval(() => {
      void this.daemonMethod("daemon/heartbeat", { sessionId });
    }, cadenceMs);
    return { stop: () => this.timer.clearInterval(handle) };
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
    this.daemon = await this.createDaemonSide();
    await this.daemon.manager.rehydratePersistedSessions(this.daemon.pool);
    this.daemon.manager.startRehydratedOwnerWindows();
  }

  async stop(): Promise<void> {
    await this.proxy.close();
    await this.daemon.monitor.stop();
    this.daemon.manager.stopCleanupTimer();
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
