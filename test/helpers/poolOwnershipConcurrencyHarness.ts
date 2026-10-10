import { CLI_SESSION_LIVENESS_POLICY } from "../../src/daemon/constants";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { registerDerivedLabelSessionReleaseCascade } from "../../src/daemon/derivedLabelSessionReleaseCascade";
import { getDevicePoolTimeoutMs } from "../../src/daemon/poolConfig";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/sessionLivenessWindows";
import {
  PLAN_AUTO_RELEASE_REASON,
  SessionManager,
  TerminalSessionError,
} from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { deviceLossCancellationReason } from "../../src/utils/deviceLossCancellationReason";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";
import { createDevicePoolDependencies } from "./devicePoolDependencies";
import { drainMicrotasks } from "./fakeTimerStepping";

// Seeded concurrency harness for device-session ownership. One seed generates a list of steps
// (acquire, release, heartbeat, control and read tool calls, heartbeat loss, time advance,
// killDevice, device disconnect/reconnect, owner connection close/reconnect, autolock attach and
// restore, executePlan label sessions, daemon restart). The runner starts each operation WITHOUT awaiting it and drains a
// seeded number of microtask turns before the next step, so operations overlap at their await
// points in an order the seed alone decides. After every step it checks the invariants that must
// hold at every instant; at settle points (all in-flight operations finished) it checks the
// stronger pool/session agreement invariants.
//
// Everything runs on the real SessionManager, DevicePool, SessionHeartbeatMonitor, daemon request
// handler (heartbeat, releaseSession) and derived-label release cascade, wired as daemon.ts wires
// them, over a FakeTimer, an in-memory session persistence and fake device discovery. Steps are
// generated independently of state, so a failing list can be shrunk by deleting steps.

export const DEVICE_COUNT = 3;
export const CLIENT_COUNT = 4;

const DEVICES: readonly BootedDevice[] = Array.from({ length: DEVICE_COUNT }, (_, i) => ({
  deviceId: `emulator-${5554 + i * 2}`,
  name: `Pixel_8_API_35_${i}`,
  platform: "android" as const,
}));

export const IDLE_WINDOW_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
/** The autolock idle window: the device pool timeout (60 s unless AUTOMOBILE_DEVICE_POOL_TIMEOUT). */
const AUTOLOCK_IDLE_WINDOW_MS = getDevicePoolTimeoutMs();
const LEASE_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS;

/** Microtask turns a settle point drains before it moves fake time to unpark operations. */
const SETTLE_TURNS = 300;
/** Fake-time nudges a settle point may spend unparking sleeping operations. */
const SETTLE_TIME_NUDGES = 75;
const SETTLE_NUDGE_MS = 1_000;

export type StepKind =
  | "acquireMcp"
  | "acquireAutolock"
  | "acquireCli"
  | "release"
  | "control"
  | "read"
  | "loseHeartbeat"
  | "resumeHeartbeat"
  | "advance"
  | "monitorTick"
  | "cleanupSweep"
  | "kill"
  | "disconnect"
  | "reconnect"
  | "closeConnection"
  | "reopenConnection"
  | "attachAutolock"
  | "restoreAutolock"
  | "planLabels"
  | "planEnd"
  | "restart"
  | "settle";

export interface Step {
  kind: StepKind;
  client: number;
  device: number;
  /** Time to advance for `advance`. */
  ms: number;
  /** Microtask turns drained after the step starts, before the next one may start. */
  turns: number;
}

export interface HarnessProfile {
  steps: number;
  /** Relative weights; a kind left out is never generated. */
  weights: Partial<Record<StepKind, number>>;
}

const ADVANCE_CHOICES_MS = [
  250,
  PROXY_HEARTBEAT_INTERVAL_MS,
  5_000,
  30_000,
  IDLE_WINDOW_MS - 5_000,
  IDLE_WINDOW_MS + 5_000,
] as const;
const TURN_CHOICES = [0, 0, 1, 2, 3, 5, 8, 13, 40] as const;

export function generateSteps(seed: number, profile: HarnessProfile): Step[] {
  const random = new SeededRandom(seed);
  const table = Object.entries(profile.weights).flatMap(([kind, weight]) =>
    Array.from({ length: weight ?? 0 }, () => kind as StepKind),
  );
  return Array.from({ length: profile.steps }, () => ({
    kind: random.pick(table),
    client: Math.floor(random.next() * CLIENT_COUNT),
    device: Math.floor(random.next() * DEVICE_COUNT),
    ms: random.pick(ADVANCE_CHOICES_MS),
    turns: random.pick(TURN_CHOICES),
  }));
}

export function describeStep(step: Step, index: number): string {
  const target =
    step.kind === "advance"
      ? `${step.ms}ms`
      : ["kill", "disconnect", "reconnect"].includes(step.kind)
        ? `d${step.device}`
        : [
              "acquireMcp",
              "acquireAutolock",
              "acquireCli",
              "attachAutolock",
              "restoreAutolock",
            ].includes(step.kind)
          ? `c${step.client} d${step.device}`
          : `c${step.client}`;
  return `#${index} ${step.kind} ${target} +${step.turns}t`;
}

interface ClientState {
  readonly index: number;
  /** Current MCP connection id, or undefined for a one-shot CLI client between invocations. */
  connection: string | undefined;
  connectionGeneration: number;
  /** Whether the owner process is alive and heartbeating every 2 s. */
  alive: boolean;
  /** The session this client believes it holds. */
  sessionId: string | undefined;
  kind: "mcp" | "cli" | undefined;
  ownerToken: string;
  needsClaim: boolean;
  /** The connection that acquired or restored `sessionId`, when that succeeded. */
  ownedVia: string | undefined;
  /** Derived executePlan label sessions this client set up for its base session. */
  labelSessions: string[];
}

interface ReleaseRecord {
  at: number;
  sessionId: string;
  deviceId: string;
  reason: string;
}

/**
 * One daemon process's view of the shared fake clock. When the process dies (a restart), its
 * pending timeouts and intervals stop firing and its sleeps never return, as a killed process's
 * would; the clock itself keeps running for the next process.
 */
export function processTimer(shared: FakeTimer, isDead: () => boolean): FakeTimer {
  const never = new Promise<void>(() => undefined);
  return new Proxy(shared, {
    get(target, property, receiver) {
      switch (property) {
        case "sleep":
          return (ms: number) =>
            isDead() ? never : target.sleep(ms).then(() => (isDead() ? never : undefined));
        case "setTimeout":
          return (callback: () => void, ms: number) =>
            target.setTimeout(() => {
              if (!isDead()) {
                callback();
              }
            }, ms);
        case "setInterval":
          return (callback: () => void, ms: number) =>
            target.setInterval(() => {
              if (!isDead()) {
                callback();
              }
            }, ms);
        default: {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

interface DaemonProcess {
  /** Set when the process is replaced by a restart. */
  dead: boolean;
  manager: SessionManager;
  pool: DevicePool;
  monitor: SessionHeartbeatMonitor;
  state: DaemonStateAccess;
}

/** The invariant a violation broke; a run can tolerate known kinds to look past them. */
export type ViolationKind =
  | "closed-connection-owns"
  | "double-release"
  | "early-idle-release"
  | "early-heartbeat-release"
  | "owner-disconnected-while-connected"
  | "foreign-session-reuse"
  | "device-two-owners"
  | "session-two-devices"
  | "pool-session-disagree"
  | "pool-stats"
  | "two-connection-owners"
  | "read-moved-idle-clock"
  | "unsettled-operation"
  | "unexpected-error";

export interface Violation {
  step: number;
  kind: ViolationKind;
  message: string;
}

export interface RunOptions {
  /** Violation kinds that are logged but do not end the run (known, reported findings). */
  tolerate?: ReadonlySet<ViolationKind>;
}

export interface RunResult {
  violation: Violation | undefined;
  trace: string[];
}

/**
 * Every connection the autolock manager routes or counts as an acquirer (its default-route map and
 * its acquired sets), read without side effects. Private state, read only here.
 */
function autolockConnections(pool: DevicePool): Set<string> {
  const manager: unknown = Reflect.get(pool, "autolockManager");
  const routes: unknown = manager ? Reflect.get(manager, "mcpSessionAutolockMap") : undefined;
  const acquired: unknown = manager
    ? Reflect.get(manager, "mcpSessionAcquiredAutolocks")
    : undefined;
  if (!(routes instanceof Map) || !(acquired instanceof Map)) {
    throw new Error("DeviceAutolockManager no longer keeps its MCP route maps; update the harness");
  }
  return new Set(
    [...routes.keys(), ...acquired.keys()].filter((c): c is string => typeof c === "string"),
  );
}

/**
 * A clean refusal: the daemon told the caller, in an actionable error, that it lost the race
 * (device taken, session terminal, device gone). Anything else surfacing from an operation is a
 * finding in its own right.
 */
export function isExpectedRefusal(error: unknown): boolean {
  return error instanceof ActionableError || error instanceof TerminalSessionError;
}

/**
 * The pool's per-connection acquisition record (connection id -> session ids), read without the
 * side effects of resolveOwnedDeviceSessionForMcpSession, which looks sessions up through
 * getSession() and so can start a lazy-expiry release mid-check. Private state, read only here.
 */
function connectionOwnership(pool: DevicePool): ReadonlyMap<string, ReadonlySet<string>> {
  const raw: unknown = Reflect.get(pool, "mcpSessionAcquiredDeviceSessions");
  if (!(raw instanceof Map)) {
    throw new Error(
      "DevicePool no longer keeps mcpSessionAcquiredDeviceSessions; update the harness",
    );
  }
  const result = new Map<string, ReadonlySet<string>>();
  for (const [connection, sessions] of raw) {
    if (typeof connection === "string" && sessions instanceof Set) {
      result.set(
        connection,
        new Set([...sessions].filter((id): id is string => typeof id === "string")),
      );
    }
  }
  return result;
}

class OwnershipWorld {
  constructor(private readonly tolerate: ReadonlySet<ViolationKind>) {}

  readonly timer = new FakeTimer();
  readonly persistence = new FakeDeviceSessionPersistence();
  readonly discovery = new FakeDeviceUtils();
  readonly releases: ReleaseRecord[] = [];
  readonly trace: string[] = [];
  /** Sessions whose release callback ran (and that were not later re-created under the id). */
  readonly released = new Map<string, ReleaseRecord>();
  /** Sessions created (or rehydrated) and not yet released, per the manager's callbacks. */
  readonly liveIncarnations = new Set<string>();
  /** Who created each session: an MCP connection, or an anonymous one-shot CLI. */
  readonly origin = new Map<string, { kind: "mcp" | "cli"; client: number; connection?: string }>();
  /** Connections that were closed; they must never own a session again. */
  readonly closedConnections = new Set<string>();
  /** End of the last admitted control call per session (creation counts). */
  readonly lastControlAt = new Map<string, number>();
  /** Sessions minted by an autolock acquisition, which idle out on the pool timeout. */
  readonly autolockSessions = new Set<string>();
  /** Last accepted owner heartbeat per session. */
  readonly lastOwnerHeartbeatAt = new Map<string, number>();
  readonly clients: ClientState[] = Array.from({ length: CLIENT_COUNT }, (_, index) => ({
    index,
    connection: undefined,
    connectionGeneration: 0,
    alive: true,
    sessionId: undefined,
    kind: undefined,
    ownerToken: `owner-${index}`,
    needsClaim: true,
    ownedVia: undefined,
    labelSessions: [],
  }));
  readonly online: boolean[] = DEVICES.map(() => true);
  private readonly inflight = new Set<Promise<void>>();
  private daemon!: DaemonProcess;
  private sessionCounter = 0;
  /** Operations launched so far; a read compares it to know it ran alone. */
  private launches = 0;
  violation: Violation | undefined;
  stepIndex = -1;

  get manager(): SessionManager {
    return this.daemon.manager;
  }

  get pool(): DevicePool {
    return this.daemon.pool;
  }

  private onlineDevices(): BootedDevice[] {
    return DEVICES.filter((_, i) => this.online[i]);
  }

  private async createDaemon(): Promise<DaemonProcess> {
    const life: { dead: boolean } = { dead: false };
    const timer = processTimer(this.timer, () => life.dead);
    const manager = new SessionManager(timer, this.persistence);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "ownership-concurrency-daemon", {
        timer,
        deviceManager: this.discovery,
        idGenerator: new FakeIdGenerator(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        env: { ...process.env },
      }),
    );
    await pool.initializeWithDevices(this.onlineDevices());
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    registerDerivedLabelSessionReleaseCascade(manager, pool);
    manager.onSessionCreated((session) => {
      if (!life.dead) {
        this.liveIncarnations.add(session.sessionId);
      }
    });
    manager.onSessionRelease((sessionId, deviceId, reason, _snapshot, options) => {
      if (life.dead || options?.upgradeOnly) {
        return;
      }
      if (!this.liveIncarnations.delete(sessionId)) {
        const previous = this.released.get(sessionId);
        this.fail(
          "double-release",
          `${sessionId} was released twice (${reason} at t=${this.timer.now()}` +
            (previous ? `, after ${previous.reason} at t=${previous.at}` : "") +
            ") without being created again in between",
        );
      }
      const record = { at: this.timer.now(), sessionId, deviceId, reason };
      this.releases.push(record);
      this.released.set(sessionId, record);
      this.log(`  release ${sessionId}@${deviceId} reason=${reason}`);
      this.checkReleaseTiming(record);
    });
    const registry = new DeviceSessionRegistry();
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => registry,
    };
    monitor.start();
    return {
      get dead() {
        return life.dead;
      },
      set dead(value: boolean) {
        life.dead = value;
      },
      manager,
      pool,
      monitor,
      state,
    };
  }

  async start(): Promise<void> {
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.daemon = await this.createDaemon();
  }

  async stop(): Promise<void> {
    await this.daemon.monitor.stop();
    this.daemon.manager.stopCleanupTimer();
    // Unpark anything still sleeping so no promise outlives the test.
    this.timer.resolveAll();
    await drainMicrotasks(SETTLE_TURNS);
  }

  log(line: string): void {
    this.trace.push(`t=${this.timer.now()} ${line}`);
  }

  fail(kind: ViolationKind, message: string): void {
    if (this.tolerate.has(kind)) {
      this.log(`  tolerated ${kind}: ${message}`);
      return;
    }
    if (!this.violation) {
      this.violation = { step: this.stepIndex, kind, message };
      this.log(`  VIOLATION ${kind}: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Invariants

  /** A release's reason must be justified by what the model saw of the session's owner. */
  private checkReleaseTiming(record: ReleaseRecord): void {
    const now = record.at;
    const lastControl = this.lastControlAt.get(record.sessionId);
    const idleReasons = ["lazy-expiry", "cleanup-expired", "cli-idle-timeout", "expired"];
    if (idleReasons.includes(record.reason) && lastControl !== undefined) {
      // An autolock session's idle window is the device pool timeout, not the session default.
      const window = this.autolockSessions.has(record.sessionId)
        ? AUTOLOCK_IDLE_WINDOW_MS
        : IDLE_WINDOW_MS;
      if (now - lastControl < window) {
        this.fail(
          "early-idle-release",
          `${record.sessionId} idle-released (${record.reason}) ${now - lastControl}ms after its ` +
            `last control call at t=${lastControl}, inside the ${window}ms idle window`,
        );
      }
    }
    if (record.reason === "owner-disconnected") {
      const holder = this.clients.find(
        (c) => c.sessionId === record.sessionId && c.kind === "mcp" && c.connection !== undefined,
      );
      if (holder?.connection && holder.ownedVia === holder.connection) {
        this.fail(
          "owner-disconnected-while-connected",
          `${record.sessionId} released as owner-disconnected while its owner c${holder.index} ` +
            `still holds it on open connection ${holder.connection}`,
        );
      }
    }
    if (record.reason === "heartbeat-timeout") {
      const owner = this.clients.find((c) => c.sessionId === record.sessionId);
      const lastBeat = this.lastOwnerHeartbeatAt.get(record.sessionId);
      if (
        owner?.alive &&
        owner.kind === "mcp" &&
        lastBeat !== undefined &&
        now - lastBeat < LEASE_MS
      ) {
        this.fail(
          "early-heartbeat-release",
          `${record.sessionId} released for heartbeat-timeout ${now - lastBeat}ms after an ` +
            `accepted heartbeat, inside the ${LEASE_MS}ms lease`,
        );
      }
    }
  }

  /** Invariants that hold at every instant, even with operations in flight. */
  checkAlways(): void {
    // A close drops the connection's autolock routes synchronously, and nothing may publish them
    // again afterwards (#11192), so a closed connection is never routed or counted as an acquirer.
    for (const connection of autolockConnections(this.pool)) {
      if (this.closedConnections.has(connection)) {
        this.fail(
          "closed-connection-owns",
          `closed connection ${connection} is still in the autolock route or acquired-set maps`,
        );
      }
    }
    const devices = this.pool.getAllDevices();
    const owners = new Map<string, string>();
    for (const device of devices) {
      if (!device.sessionId) {
        continue;
      }
      const other = owners.get(device.sessionId);
      if (other) {
        this.fail(
          "session-two-devices",
          `session ${device.sessionId} owns two devices: ${other} and ${device.id}`,
        );
      }
      owners.set(device.sessionId, device.id);
    }
    const byDevice = new Map<string, string>();
    for (const session of this.manager.getAllSessions()) {
      if (this.manager.getReleasingSession(session.sessionId)) {
        continue;
      }
      const other = byDevice.get(session.assignedDevice);
      if (other && other !== session.sessionId) {
        this.fail(
          "device-two-owners",
          `device ${session.assignedDevice} has two live owning sessions: ${other} and ${session.sessionId}`,
        );
      }
      byDevice.set(session.assignedDevice, session.sessionId);
    }
  }

  /** Invariants that hold once every in-flight operation has finished. */
  checkSettled(): void {
    this.checkAlways();
    const devices = this.pool.getAllDevices();
    // Checks must not change what they observe: getSession() lazily expires (and starts releasing)
    // a session past its deadline, so read the manager's maps through side-effect-free lookups.
    const live = new Map(this.manager.getAllSessions().map((s) => [s.sessionId, s]));
    for (const device of devices) {
      if (device.sessionId) {
        const session = live.get(device.sessionId);
        // A session past its deadline stays in the map until the lazy expiry releases it.
        const awaitingExpiry = !session && this.manager.hasSession(device.sessionId);
        if (!session && !awaitingExpiry) {
          const released = this.released.get(device.sessionId);
          this.fail(
            "pool-session-disagree",
            `device ${device.id} is still assigned to ${device.sessionId}, which ` +
              (released
                ? `was released at t=${released.at} (${released.reason})`
                : "the session manager does not know"),
          );
        } else if (session && session.assignedDevice !== device.id) {
          this.fail(
            "pool-session-disagree",
            `device ${device.id} names ${device.sessionId}, whose session is on ${session.assignedDevice}`,
          );
        }
        if (device.status !== "busy") {
          this.fail(
            "pool-session-disagree",
            `device ${device.id} is assigned to ${device.sessionId} but ${device.status}`,
          );
        }
      } else if (device.status === "busy") {
        this.fail("pool-session-disagree", `device ${device.id} is busy with no session`);
      }
    }
    for (const session of this.manager.getAllSessions()) {
      const device = this.pool.getDevice(session.assignedDevice);
      if (device?.sessionId !== session.sessionId) {
        this.fail(
          "pool-session-disagree",
          `live session ${session.sessionId} is on ${session.assignedDevice}, but the pool has ` +
            (device ? `it ${device.status} for ${device.sessionId ?? "nobody"}` : "no such device"),
        );
      }
    }
    const stats = this.pool.getStats();
    const busy = devices.filter((d) => d.status === "busy").length;
    const idle = devices.filter((d) => d.status === "idle" && !d.sessionId).length;
    if (stats.assigned !== busy || stats.idle !== idle || stats.total !== devices.length) {
      this.fail(
        "pool-stats",
        `pool stats ${JSON.stringify(stats)} disagree with devices (busy=${busy}, idle=${idle}, ` +
          `total=${devices.length})`,
      );
    }
    if (stats.idle + stats.assigned + stats.error > stats.total) {
      this.fail("pool-stats", `pool slot counts exceed the device total: ${JSON.stringify(stats)}`);
    }
    const acquired = connectionOwnership(this.pool);
    const connectionOwners = new Map<string, string>();
    for (const [connection, sessionIds] of acquired) {
      for (const sessionId of sessionIds) {
        if (!live.has(sessionId)) {
          continue;
        }
        if (this.closedConnections.has(connection)) {
          this.fail(
            "closed-connection-owns",
            `closed connection ${connection} still owns live session ${sessionId}`,
          );
        }
        // No live session is owned by two open MCP connections.
        const other = connectionOwners.get(sessionId);
        if (
          other &&
          !this.closedConnections.has(connection) &&
          !this.closedConnections.has(other)
        ) {
          this.fail(
            "two-connection-owners",
            `session ${sessionId} is owned by two open connections: ${other} and ${connection}`,
          );
        }
        connectionOwners.set(sessionId, connection);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Operations

  /** Start `operation` without awaiting it; failures are classified when it settles. */
  launch(label: string, operation: () => Promise<void>): void {
    this.launches++;
    const run = operation().then(
      () => undefined,
      (error: unknown) => {
        if (!isExpectedRefusal(error)) {
          this.fail(
            "unexpected-error",
            `${label} threw ${error instanceof Error ? error.constructor.name : typeof error}: ${errorMessage(error)}`,
          );
        } else {
          this.log(`  ${label} refused: ${errorMessage(error).slice(0, 140)}`);
        }
      },
    );
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  private connectionFor(client: ClientState): string {
    if (!client.connection) {
      client.connectionGeneration++;
      client.connection = `conn-${client.index}-${client.connectionGeneration}`;
    }
    return client.connection;
  }

  async heartbeat(client: ClientState): Promise<void> {
    const sessionId = client.sessionId;
    if (!sessionId || client.kind !== "mcp") {
      return;
    }
    const claim = client.needsClaim;
    const response = await handleDaemonRequest(
      {
        id: `hb-${client.index}`,
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId,
          livenessOwnerToken: client.ownerToken,
          ...(claim ? { claimLivenessOwnership: true } : {}),
        },
      },
      this.daemon.state,
    );
    if (response.success) {
      client.needsClaim = false;
      this.lastOwnerHeartbeatAt.set(sessionId, this.timer.now());
    } else if (client.sessionId === sessionId && !this.manager.hasSession(sessionId)) {
      // The proxy learns its session is gone from the refused heartbeat.
      this.log(`  c${client.index} heartbeat refused: session ${sessionId} gone`);
      client.sessionId = undefined;
    }
  }

  /** getAndroid-style explicit bind of a named device for an MCP connection or a one-shot CLI. */
  acquire(
    client: ClientState,
    deviceIndex: number,
    kind: "mcp" | "cli",
    via: "bind" | "autolock" = "bind",
  ): void {
    const device = DEVICES[deviceIndex]!;
    const sessionId = `s${++this.sessionCounter}`;
    const connection = kind === "mcp" ? this.connectionFor(client) : undefined;
    this.log(`c${client.index} acquire(${kind}/${via}) ${device.deviceId} as ${sessionId}`);
    this.launch(`c${client.index} acquire ${device.deviceId}`, async () => {
      // An autolock acquisition mints its own session id; an absent result is a lost race.
      const bound =
        via === "autolock"
          ? await this.pool.autolockDevice(
              device.deviceId,
              "android",
              connection,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              "automationReady",
              undefined,
              { autolockEnabled: true },
            )
          : await this.pool.bindOrReuseDeviceSession(
              sessionId,
              device.deviceId,
              "android",
              undefined,
              undefined,
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              connection,
              kind === "cli",
            );
      if (bound === undefined) {
        return;
      }
      if (via === "autolock") {
        this.autolockSessions.add(bound);
      }
      const boundSession = this.manager.getAllSessions().find((s) => s.sessionId === bound);
      this.log(
        `  c${client.index} bound ${device.deviceId} -> ${bound} (created t=${boundSession?.createdAt}, lastUsedAt t=${boundSession?.lastUsedAt})`,
      );
      const origin = this.origin.get(bound);
      if (bound !== sessionId && !(via === "autolock" && !origin)) {
        // The same client whose acquisition outlived its connection, after its reconnect restored
        // the session onto a newer one, is not handed a foreign session: the reply goes nowhere.
        const sameOwner =
          kind === "cli"
            ? origin?.kind === "cli"
            : origin?.kind === "mcp" &&
              (origin.connection === connection ||
                (origin.client === client.index &&
                  connection !== undefined &&
                  this.closedConnections.has(connection)));
        if (!sameOwner) {
          this.fail(
            "foreign-session-reuse",
            `c${client.index} (${kind}${connection ? ` on ${connection}` : ""}) was handed ` +
              `${bound}, which ${origin ? `${origin.kind} client c${origin.client}${origin.connection ? ` on ${origin.connection}` : ""} created` : "nobody in this run created"}`,
          );
        }
      } else {
        this.origin.set(bound, { kind, client: client.index, connection });
      }
      if (!origin && boundSession) {
        // The idle window of a minted session starts at its creation inside the bind; the
        // acquisition call's end is not recorded as activity for it (it carried no sessionUuid).
        this.released.delete(bound);
        this.lastControlAt.set(bound, boundSession.lastUsedAt);
      }
      client.sessionId = bound;
      client.kind = kind;
      client.ownedVia = kind === "mcp" && client.connection === connection ? connection : undefined;
      client.labelSessions = [];
      if (kind === "mcp") {
        client.needsClaim = true;
        client.ownerToken = `owner-${client.index}-${bound}`;
        await this.heartbeat(client);
      } else {
        const adopted = await handleDaemonRequest(
          {
            id: `cli-${client.index}`,
            type: "daemon_request",
            method: "daemon/heartbeat",
            params: {
              sessionId: bound,
              livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
              // Every one-shot invocation is a new process with its own owner token.
              livenessOwnerToken: `cli-${client.index}-${sessionId}`,
              claimLivenessOwnership: true,
            },
          },
          this.daemon.state,
        );
        this.log(`  c${client.index} cli-idle adoption ${JSON.stringify(adopted)}`);
      }
    });
  }

  release(client: ClientState): void {
    const sessionId = client.sessionId;
    if (!sessionId) {
      return;
    }
    this.log(`c${client.index} releaseSession ${sessionId}`);
    this.launch(`c${client.index} release ${sessionId}`, async () => {
      const response = await handleDaemonRequest(
        {
          id: `rel-${client.index}`,
          type: "daemon_request",
          method: "daemon/releaseSession",
          params: { sessionId },
        },
        this.daemon.state,
      );
      if (!response.success) {
        throw new Error(`releaseSession failed: ${JSON.stringify(response)}`);
      }
      if (client.sessionId === sessionId) {
        client.sessionId = undefined;
      }
    });
  }

  /** A device-control tool call: admitted at its start, activity again at its end. */
  control(client: ClientState): void {
    const sessionId = client.sessionId;
    if (!sessionId) {
      return;
    }
    this.log(`c${client.index} control ${sessionId}`);
    this.launch(`c${client.index} control ${sessionId}`, async () => {
      await this.manager.getOrCreateSession(sessionId);
      this.lastControlAt.set(sessionId, this.timer.now());
      await drainMicrotasks(2);
      this.manager.recordToolCallEnded(sessionId, { admitted: true });
      this.lastControlAt.set(sessionId, this.timer.now());
    });
  }

  /** A read-only tool call (observe-style): must never move the idle clocks. */
  read(client: ClientState): void {
    const sessionId = client.sessionId;
    if (!sessionId) {
      return;
    }
    const before = this.manager.getSession(sessionId);
    // Only a read that runs alone can be judged: a concurrent control call or heartbeat may move
    // the clocks legitimately while the read is in flight.
    const alone = this.inflight.size === 0;
    const startedAt = this.timer.now();
    const launchesAtStart = this.launches + 1;
    const snapshot = before
      ? { lastUsedAt: before.lastUsedAt, expiresAt: before.expiresAt }
      : undefined;
    this.log(`c${client.index} read ${sessionId}`);
    this.launch(`c${client.index} read ${sessionId}`, async () => {
      const session = await this.manager.getOrCreateSession(
        sessionId,
        undefined,
        undefined,
        undefined,
        false,
        "read-only",
      );
      const ranAlone = alone && this.launches === launchesAtStart && this.timer.now() === startedAt;
      if (
        ranAlone &&
        snapshot &&
        session === before &&
        (session.lastUsedAt !== snapshot.lastUsedAt || session.expiresAt > snapshot.expiresAt)
      ) {
        this.fail(
          "read-moved-idle-clock",
          `read-only access to ${sessionId} moved its idle clocks: lastUsedAt ` +
            `${snapshot.lastUsedAt}->${session.lastUsedAt}, expiresAt ${snapshot.expiresAt}->${session.expiresAt}`,
        );
      }
    });
  }

  /** Advance fake time in heartbeat-cadence chunks; live MCP owners heartbeat each chunk. */
  async advance(ms: number): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(PROXY_HEARTBEAT_INTERVAL_MS, remaining);
      this.timer.advanceTime(chunk);
      remaining -= chunk;
      for (const client of this.clients) {
        if (client.alive && client.connection && client.kind === "mcp" && client.sessionId) {
          await this.heartbeat(client);
        }
      }
      await drainMicrotasks(20);
      this.checkAlways();
      if (this.violation) {
        return;
      }
    }
  }

  /** killDevice: reserve the incarnation, release its session, retire it from the pool. */
  kill(deviceIndex: number): void {
    const device = DEVICES[deviceIndex]!;
    this.log(`killDevice ${device.deviceId}`);
    this.launch(`killDevice ${device.deviceId}`, async () => {
      const reservation = await this.pool.reserveDeviceForShutdown(device.deviceId);
      if (!reservation) {
        return;
      }
      try {
        this.online[deviceIndex] = false;
        this.discovery.setBootedDevices("android", this.onlineDevices());
        const session = reservation.session;
        if (session && session.assignedDevice === device.deviceId) {
          await this.manager.releaseSessionIfOwned(
            session.sessionId,
            session,
            device.deviceId,
            "device-killed",
          );
        }
        if (this.pool.getDevice(device.deviceId) === reservation.device) {
          await this.pool.retireDeviceForShutdown(reservation.device);
        }
      } finally {
        await reservation.release();
      }
    });
  }

  /** adb loses the serial: the daemon cancels the bound session and drops the device. */
  disconnect(deviceIndex: number): void {
    const device = DEVICES[deviceIndex]!;
    this.online[deviceIndex] = false;
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.log(`disconnect ${device.deviceId}`);
    this.launch(`disconnect ${device.deviceId}`, async () => {
      const pooled = this.pool.getDevice(device.deviceId);
      const sessionId = pooled?.sessionId ?? null;
      if (sessionId && this.manager.getSession(sessionId)) {
        await releaseSessionAndDevice(
          this.manager,
          this.pool,
          device.deviceId,
          sessionId,
          deviceLossCancellationReason(device.deviceId),
        );
      }
      await this.pool.removeDisconnectedDevice(
        device.deviceId,
        false,
        undefined,
        pooled ?? undefined,
      );
    });
  }

  reconnect(deviceIndex: number): void {
    const device = DEVICES[deviceIndex]!;
    if (this.online[deviceIndex]) {
      return;
    }
    this.online[deviceIndex] = true;
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.log(`reconnect ${device.deviceId}`);
    this.launch(`reconnect ${device.deviceId}`, async () => {
      await this.pool.refreshDevices();
    });
  }

  closeConnection(client: ClientState): void {
    const connection = client.connection;
    if (!connection) {
      return;
    }
    this.log(`c${client.index} close ${connection}`);
    client.connection = undefined;
    client.ownedVia = undefined;
    client.alive = false;
    this.closedConnections.add(connection);
    this.pool.releaseMcpSessionBindings(connection);
  }

  /** The owner's proxy reconnects and restores ownership of the session it holds. */
  reopenConnection(client: ClientState): void {
    if (client.connection || client.kind !== "mcp") {
      return;
    }
    const connection = this.connectionFor(client);
    client.alive = true;
    client.needsClaim = true;
    const sessionId = client.sessionId;
    this.log(`c${client.index} reopen ${connection} restoring ${sessionId ?? "nothing"}`);
    this.launch(`c${client.index} reopen`, async () => {
      if (sessionId) {
        await this.pool.restoreOwnedDeviceSessionsForMcpSession([sessionId], connection);
        const device = this.manager.getSession(sessionId)?.assignedDevice;
        if (
          device &&
          client.connection === connection &&
          this.pool.resolveOwnedDeviceSessionForMcpSession(connection, device) === sessionId
        ) {
          // An acquisition that finished while this restore waited may have moved the client on
          // to another session; it no longer holds this one, but the connection still owns it.
          if (client.sessionId === sessionId) {
            client.ownedVia = connection;
          }
          // Restoration hands the session to the reconnected connection.
          const origin = this.origin.get(sessionId);
          if (origin?.kind === "mcp") {
            this.origin.set(sessionId, { ...origin, connection });
          }
        }
        await this.heartbeat(client);
      }
    });
  }

  /**
   * A tool call naming a live autolock session (`via` "explicit") or a setActiveDevice selecting it
   * (`via` "select"): the pool attaches it to the client's connection unless another connected
   * client owns it. The model's holder bookkeeping is left alone: only the pool's maps are judged.
   */
  attachAutolock(client: ClientState, deviceIndex: number, via: "explicit" | "select"): void {
    const sessionId = this.pool.getDevice(DEVICES[deviceIndex]!.deviceId)?.autolockSessionId;
    if (!sessionId) {
      return;
    }
    const connection = this.connectionFor(client);
    this.log(`c${client.index} attach(${via}) ${sessionId} on ${connection}`);
    this.launch(`c${client.index} attach ${sessionId}`, async () => {
      const outcome =
        via === "explicit"
          ? await this.pool.attachExplicitSessionUuidCall(sessionId, connection)
          : await this.pool.attachAutolockSessionToMcpSession(sessionId, connection, true, true);
      this.log(`  c${client.index} attach ${sessionId} -> ${outcome}`);
      this.adoptAttachedOrigin(client, sessionId, connection);
    });
  }

  /** The client's proxy reconnects and restores the autolock session it retained (or names). */
  restoreAutolock(client: ClientState, deviceIndex: number): void {
    const named = this.pool.getDevice(DEVICES[deviceIndex]!.deviceId)?.autolockSessionId;
    const retained =
      client.sessionId && this.autolockSessions.has(client.sessionId) ? client.sessionId : named;
    if (!retained) {
      return;
    }
    const connection = this.connectionFor(client);
    this.log(`c${client.index} restore autolock ${retained} on ${connection}`);
    this.launch(`c${client.index} restore autolock ${retained}`, async () => {
      await this.pool.restoreAutolockSessionsForMcpSession([retained], connection);
      this.adoptAttachedOrigin(client, retained, connection);
    });
  }

  /** An attach that took ownership hands the session to that connection, like a restore. */
  private adoptAttachedOrigin(client: ClientState, sessionId: string, connection: string): void {
    if (
      client.connection === connection &&
      connectionOwnership(this.pool).get(connection)?.has(sessionId)
    ) {
      this.origin.set(sessionId, { kind: "mcp", client: client.index, connection });
    }
  }

  /** executePlan with `device:` labels: a derived `${base}:B` session on another idle device. */
  planLabels(client: ClientState): void {
    const base = client.sessionId;
    if (!base || client.labelSessions.length > 0) {
      return;
    }
    const derived = `${base}:B`;
    client.labelSessions = [derived];
    this.log(`c${client.index} plan labels ${base} + ${derived}`);
    this.launch(`c${client.index} planLabels ${base}`, async () => {
      if (!this.manager.getSession(base)) {
        return;
      }
      this.manager.setDeviceLabels(base, { A: base, B: derived });
      const session = await this.manager.getOrCreateSession(derived, this.pool, "android");
      this.lastControlAt.set(derived, this.timer.now());
      this.released.delete(derived);
      this.log(`  ${derived} on ${session.assignedDevice}`);
    });
  }

  /** The plan finishes: its derived label sessions are auto-released. */
  planEnd(client: ClientState): void {
    const derived = client.labelSessions;
    client.labelSessions = [];
    for (const sessionId of derived) {
      this.log(`c${client.index} plan end ${sessionId}`);
      this.launch(`c${client.index} planEnd ${sessionId}`, async () => {
        const session = this.manager.getSession(sessionId);
        if (!session) {
          return;
        }
        await releaseSessionAndDevice(
          this.manager,
          this.pool,
          session.assignedDevice,
          sessionId,
          PLAN_AUTO_RELEASE_REASON,
        );
      });
    }
  }

  /**
   * The daemon process restarts: live sessions are persisted for recovery, every socket closes,
   * and the new process rehydrates them awaiting their owners.
   */
  async restart(): Promise<void> {
    await this.settle();
    const old = this.daemon;
    this.log("daemon restart");
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
    old.dead = true;
    for (const client of this.clients) {
      if (client.connection) {
        this.closedConnections.add(client.connection);
      }
      client.connection = undefined;
      client.ownedVia = undefined;
      client.needsClaim = true;
    }
    this.daemon = await this.createDaemon();
    this.liveIncarnations.clear();
    await this.daemon.manager.rehydratePersistedSessions(this.daemon.pool);
    for (const session of this.daemon.manager.getAllSessions()) {
      this.liveIncarnations.add(session.sessionId);
    }
    this.daemon.manager.startRehydratedOwnerWindows();
    for (const client of this.clients) {
      if (client.sessionId && client.kind === "mcp" && client.alive) {
        this.reopenConnection(client);
      }
    }
  }

  /** Let every in-flight operation finish, moving fake time only if one is parked on a sleep. */
  async settle(): Promise<void> {
    for (let nudge = 0; nudge <= SETTLE_TIME_NUDGES && this.inflight.size > 0; nudge++) {
      for (let turn = 0; turn < SETTLE_TURNS && this.inflight.size > 0; turn++) {
        await Promise.resolve();
      }
      if (this.inflight.size > 0 && nudge < SETTLE_TIME_NUDGES) {
        await this.advance(SETTLE_NUDGE_MS);
      }
    }
    if (this.inflight.size > 0) {
      this.fail("unsettled-operation", `${this.inflight.size} operation(s) never settled`);
    }
    await drainMicrotasks(60);
  }

  async apply(step: Step): Promise<void> {
    const client = this.clients[step.client]!;
    switch (step.kind) {
      case "acquireMcp":
        this.acquire(client, step.device, "mcp");
        break;
      case "acquireAutolock":
        this.acquire(client, step.device, "mcp", "autolock");
        break;
      case "acquireCli":
        this.acquire(client, step.device, "cli");
        break;
      case "release":
        this.release(client);
        break;
      case "control":
        this.control(client);
        break;
      case "read":
        this.read(client);
        break;
      case "loseHeartbeat":
        this.log(`c${client.index} stops heartbeating`);
        client.alive = false;
        break;
      case "resumeHeartbeat":
        this.log(`c${client.index} resumes heartbeating`);
        client.alive = client.connection !== undefined;
        break;
      case "advance":
        this.log(`advance ${step.ms}ms`);
        await this.advance(step.ms);
        break;
      case "monitorTick":
        this.log("monitor tick");
        this.launch("monitor tick", () => this.daemon.monitor.tick());
        break;
      case "cleanupSweep":
        this.log("cleanup sweep");
        this.manager.cleanupExpiredSessions();
        break;
      case "kill":
        this.kill(step.device);
        break;
      case "disconnect":
        this.disconnect(step.device);
        break;
      case "reconnect":
        this.reconnect(step.device);
        break;
      case "closeConnection":
        this.closeConnection(client);
        break;
      case "reopenConnection":
        this.reopenConnection(client);
        break;
      case "attachAutolock":
        // The otherwise unused advance choice picks the entry point, so the step list (and every
        // existing seed's) is unchanged.
        this.attachAutolock(
          client,
          step.device,
          ADVANCE_CHOICES_MS.indexOf(step.ms) % 2 === 0 ? "explicit" : "select",
        );
        break;
      case "restoreAutolock":
        this.restoreAutolock(client, step.device);
        break;
      case "planLabels":
        this.planLabels(client);
        break;
      case "planEnd":
        this.planEnd(client);
        break;
      case "restart":
        await this.restart();
        break;
      case "settle":
        await this.settle();
        this.checkSettled();
        break;
    }
    await drainMicrotasks(step.turns);
  }
}

/** Replay `steps` against a fresh world; stops at the first invariant violation. */
export async function runSteps(
  steps: readonly Step[],
  options: RunOptions = {},
): Promise<RunResult> {
  const world = new OwnershipWorld(options.tolerate ?? new Set());
  try {
    await world.start();
    for (const [index, step] of steps.entries()) {
      world.stepIndex = index;
      world.log(describeStep(step, index));
      await world.apply(step);
      world.checkAlways();
      if (world.violation) {
        break;
      }
    }
    if (!world.violation) {
      world.stepIndex = steps.length;
      await world.settle();
      world.checkSettled();
    }
    return { violation: world.violation, trace: world.trace };
  } finally {
    await world.stop();
  }
}

/** Delete steps one at a time while the run still fails (bounded; runs only on a failure). */
export async function shrinkSteps(
  steps: readonly Step[],
  options: RunOptions = {},
): Promise<Step[]> {
  const first = await runSteps(steps, options);
  if (!first.violation) {
    return [...steps];
  }
  let current = steps.slice(0, first.violation.step + 1);
  let changed = true;
  for (let pass = 0; pass < 4 && changed; pass++) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      const result = await runSteps(candidate, options);
      // Keep the deletion only while the run still breaks the SAME invariant.
      if (result.violation?.kind === first.violation.kind) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

function positiveIntEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A local seed sweep, when AUTOMOBILE_POOL_OWNERSHIP_SEEDS (how many) and/or
 * AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE (first seed) are set; undefined to use the checked-in seeds.
 */
export function ownershipSeedOverride(): number[] | undefined {
  const count = positiveIntEnv("AUTOMOBILE_POOL_OWNERSHIP_SEEDS");
  const base = positiveIntEnv("AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE");
  if (!count && base === undefined) {
    return undefined;
  }
  return Array.from({ length: count || 1 }, (_, i) => (base ?? 1) + i);
}

/** Run each seed; on the first violation, shrink it and throw a replayable report. */
export async function assertOwnershipInvariants(
  seeds: readonly number[],
  profile: HarnessProfile,
  options: RunOptions = {},
): Promise<void> {
  for (const seed of seeds) {
    const steps = generateSteps(seed, profile);
    const result = await runSteps(steps, options);
    if (result.violation) {
      const shrunk = await shrinkSteps(steps, options);
      const replay = await runSteps(shrunk, options);
      throw new Error(
        `Ownership invariant [${result.violation.kind}] violated for seed ${seed}: ` +
          `${result.violation.message}\n` +
          `Replay: AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE=${seed} AUTOMOBILE_POOL_OWNERSHIP_SEEDS=1\n` +
          `Shrunk to ${shrunk.length} steps (${replay.violation?.message ?? "no longer fails"}):\n` +
          `${shrunk.map(describeStep).join("\n")}\nTrace:\n${replay.trace.join("\n")}`,
      );
    }
  }
}
