import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";
import {
  DaemonClient,
  type DaemonClientLike,
  type DaemonMethodCallOptions,
} from "../../src/daemon/client";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_VERSION,
  getCliSessionIdleTimeoutMs,
} from "../../src/daemon/constants";
import { Daemon, type DaemonStartHost } from "../../src/daemon/daemon";
import {
  defaultAppearanceSyncDependencies,
  type AppearanceSyncTarget,
} from "../../src/daemon/AppearanceSyncScheduler";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { defaultRecordingSessionCleanupDeps } from "../../src/server/recordingSessionCleanup";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { AppearanceSocketServer } from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketResponse } from "../../src/daemon/appearanceSocketTypes";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
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
import { DefaultDeviceSettingsAccess } from "../../src/features/utility/DeviceSettingDefaults";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeToolSelectionProfileProvenanceLoader } from "../fakes/FakeToolSelectionProfileProvenanceLoader";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { createDaemonTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { toolErrorResult, type WireFixture } from "../daemon/helpers/desktopWireHarness";
import {
  IN_MEMORY_DATA_DIR,
  InMemoryControlSocket,
  InMemoryDaemonClient,
  ProcessTimer,
  RawFrameClient,
  assertNotHostDaemonPath,
  loopbackMcpClientFactory,
  type InMemoryClientSocket,
  type WireEnvelope,
} from "./inMemoryDaemonWire";
import { drainMicrotasks } from "./fakeTimerStepping";
import { RealToolCallPath, type DeviceToolRun } from "./realToolCallPath";

// Two-sided liveness scenario harness (#10667, umbrella #10655).
//
// Every "kept while X" assertion is paired with a "released when Y" assertion on the same
// scenario, driven by the real producers rather than by hand-called SessionManager probes.
//
// Real, and wired by production code rather than by this file (#11441):
// - the daemon: a real `Daemon` started through `Daemon.startOn()`, the body of `start()`. Its
//   constructor wires the session lifecycle (expiry canceller, recording cleanup, release
//   broadcast, in-flight vetoes); its start sequence subscribes tool-call-end activity, expires
//   the previous process's rows, adopts the terminal-release journal, discovers devices,
//   rehydrates sessions and starts the heartbeat monitor, in that order. A restart is a new
//   `Daemon` started the same way over the same database and journal directory.
// - the control socket: a real `UnixSocketServer` over that daemon's state, opened by its own
//   `startDetached()` (framing, admission, the `daemon/*` and `ide/*` handlers, selector-session
//   restore, forward routing, and the release, list-changed and resource-updated fan-out).
// - the clients: `DaemonMcpProxy` built like src/index.ts over a real `DaemonClient`, and raw
//   frame clients for the desktop, JUnit and `--cli` actors.
// - a device tool call: the real registration through the real ToolRegistry, session admission
//   and execution tracker (#10839; see RealToolCallPath).
// Faked: the kernel socket (in-process socket ends), the loopback MCP HTTP hop behind the socket
// server (its tool-call entry is RealToolCallPath plus the entry's error shaping), device
// acquisition's device work, the tool body's device work, device discovery and readiness, the
// recording operations, host appearance sync's host and device ends, the data directory (an
// in-memory file system), and the clock (FakeTimer).
// Nothing here reaches the host: the start steps that would (working directory, signal handlers,
// PID file, HTTP and socket listeners, device monitors) are this file's no-op `DaemonStartHost`,
// and every path handed to production code passes `assertNotHostDaemonPath`.
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
/** A JUnit runner heartbeats its session every second (the JUnit runner's DaemonHeartbeat). */
export const JUNIT_HEARTBEAT_MS = 1_000;
export const AUTOLOCK_WINDOW_MS = 60_000;

/** The clock step a slow daemon start is waited out in. */
const SLOW_START_STEP_MS = 1_000;
/** Microtask turns for a starting daemon to reach its next wait: about four times the ~250 measured. */
const SLOW_START_TURNS = 1_024;
/** Microtask turns per fake-timer event so a keeper round trip settles before the next tick. */
const TURNS_PER_EVENT = 32;
const CONNECTION = "scenario-connection";
/** The socket connection of a client with no stdio proxy in front (a `--cli` call, desktop, JUnit). */
export const SOCKET_CLIENT_CONNECTION = "scenario-socket-client";
/** The desktop/IDE client's own connection: it acquires and heartbeats on it. */
export const DESKTOP_CONNECTION = "desktop-connection";
/** The desktop/IDE client's connection for its `ide/*` and `input/*` frames. */
const IDE_FRAME_CONNECTION = "scenario-ide-frames";
/** The connection of a `--daemon heartbeat` keeper process. */
const CLI_KEEPER_CONNECTION = "scenario-cli-keeper";
export const OWNER_TOKEN = "scenario-proxy-owner";
const PLATFORM = "android" as const;
/**
 * The device tool a scenario's "tool call" uses: a control call, because only control calls are
 * activity (#10964). A read (`observe`) never extends a session's idle window.
 */
const CONTROL_TOOL = "homeScreen";

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

/** The PID the scenario's daemon claims devices under, and the one a peer daemon claims under. */
export const SCENARIO_DAEMON_PID = 1111;
export const PEER_DAEMON_PID = 2222;

export interface LivenessScenarioOptions {
  /**
   * Give the daemon's pool a claim store shared with a peer daemon (device id -> owning PID, see
   * {@link LivenessScenario.deviceClaims}) instead of the process-wide claim files, so a scenario
   * can have a peer take a device while the daemon is down.
   */
  sharedDeviceClaims?: boolean;
  /** Device ids in the pool; the first is the default acquisition target. */
  devices?: string[];
  /** Autolock acquisition with the 60 s window (AUTOMOBILE_DEVICE_POOL_AUTOLOCK). */
  autolock?: boolean;
}

/** Drops a dead daemon's listeners on process-wide registries. Teardown only, never wiring. */
interface DaemonProcessTeardown {
  stopSessionTimers(): void;
}

interface DaemonSide {
  daemon: Daemon;
  manager: SessionManager;
  pool: DevicePool;
  state: DaemonStateAccess;
  /** The daemon's control socket, accepting in-process connections. */
  socket: InMemoryControlSocket;
  /** The process's timers. */
  clock: ProcessTimer;
}

/** A tool call the daemon refused or failed: the `isError` result a raw socket client receives. */
export class ToolCallRefused extends Error {
  constructor(
    message: string,
    readonly result: unknown,
  ) {
    super(message);
    this.name = "ToolCallRefused";
  }
}

/** The daemon answered a frame with `success: false`. */
export class DaemonRequestFailed extends Error {
  constructor(readonly envelope: WireEnvelope) {
    super(envelope.error ?? "daemon request failed");
    this.name = "DaemonRequestFailed";
  }
}

function isErrorResult(result: unknown): result is { isError: true; content?: unknown } {
  return typeof result === "object" && result !== null && Reflect.get(result, "isError") === true;
}

function errorResultText(result: { content?: unknown }): string {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = typeof first === "object" && first !== null ? Reflect.get(first, "text") : undefined;
  return typeof text === "string" ? text : JSON.stringify(result);
}

/**
 * The `Daemon` methods that touch the machine. A scenario's daemon must only ever reach them
 * through its `DaemonStartHost`, which replaces them; on that daemon each one throws, so a
 * start step that bypasses the host fails the scenario before it can reach the host's daemon.
 */
const HOST_TOUCHING_DAEMON_METHODS = [
  "enterDaemonProcess",
  "setupShutdownHandlers",
  "writeEarlyOwnerRecord",
  "writePidFile",
  "persistPidFileData",
  "startHttpIngress",
  "startHttpServer",
  "bindControlSocket",
  "startServicesAfterSocketBind",
  "startAuxiliarySocket",
  "startMaintenanceMonitors",
  "stop",
] as const;

function armHostTripwires(daemon: Daemon): void {
  for (const method of HOST_TOUCHING_DAEMON_METHODS) {
    if (typeof Reflect.get(daemon, method) !== "function") {
      throw new Error(
        `LivenessScenario: Daemon.${method}() no longer exists; update the tripwires`,
      );
    }
    Reflect.set(daemon, method, () => {
      throw new Error(`LivenessScenario: Daemon.${method}() would touch the host`);
    });
  }
}

/** Managed-slot exclusion that holds nothing: the host-wide slot registry is never opened. */
const NO_MANAGED_SLOTS = {
  refresh: async () => {},
  holderOf: () => undefined,
  stableIdsFor: () => new Set<string>(),
};

/**
 * The proxy's daemon client: the real one, over the in-memory control socket. It only observes
 * heartbeat frames (to count them) and can lose them (a transport that swallows the frame).
 */
class ScenarioDaemonClient extends InMemoryDaemonClient {
  constructor(
    dial: () => InMemoryClientSocket | undefined,
    timer: FakeTimer,
    private readonly heartbeats: {
      dropped(): boolean;
      stall(): Promise<void>;
      delivered(params: Record<string, unknown>): void;
    },
  ) {
    super(dial, timer, new FakeIdGenerator());
  }

  override async callDaemonMethod(
    method: string,
    params: Record<string, unknown> = {},
    options: DaemonMethodCallOptions = {},
  ): Promise<unknown> {
    if (method !== "daemon/heartbeat") {
      return await super.callDaemonMethod(method, params, options);
    }
    if (this.heartbeats.dropped()) {
      return {};
    }
    await this.heartbeats.stall();
    try {
      return await super.callDaemonMethod(method, params, options);
    } finally {
      this.heartbeats.delivered(params);
    }
  }
}

interface LongCall {
  /** The device work ends now; resolves once the call's own answer (or failure) has arrived. */
  settle(): Promise<void>;
  /** The caller's view of the call: its result, or the failure it was answered with. */
  done: Promise<unknown>;
  /** The failure the caller was answered with so far, if any (e.g. the request's deadline). */
  failure(): unknown;
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
  /** The daemon's session persistence: a real repository over an in-memory database. */
  repository!: DeviceSessionRepository;
  readonly releases: ReleaseRecord[] = [];
  readonly reaped: Array<{ sessionId: string; reason: string }> = [];
  readonly deviceIds: string[];
  /** The data directory a restarted daemon finds the terminal-release journal in. */
  readonly journalFiles = new FakeTerminalReleaseJournalFileSystem();
  /** Device claims by owning daemon PID when `sharedDeviceClaims` is set. */
  readonly deviceClaims = new Map<string, number>();
  /**
   * Runs as the daemon publishes its claim on a device, before the store decides: a peer that
   * claims here wins the race the daemon's earlier foreign-owner check could not see.
   */
  beforeDeviceClaim: ((deviceId: string) => void) | undefined;
  /** Heartbeat frames the proxy keepers delivered, by session. */
  readonly heartbeatsBySession = new Map<string, number>();
  /** Heartbeat frames delivered, by owner token. */
  readonly heartbeatsByToken = new Map<string, number>();
  /**
   * Session-release pushes the stream servers key off (`SessionReleaseBroadcaster`, the channel
   * the video and WebRTC servers re-authorize their subscribers on), in emission order.
   */
  readonly releaseBroadcasts: Array<{ at: number; sessionId: string; reason: string }> = [];
  /** Sessions whose in-flight tool call the daemon aborted, in order. */
  get abortedCalls(): Array<string | undefined> {
    return this.tools.cancelledExecutions.map((cancelled) => cancelled.sessionUuid);
  }
  /**
   * Recording cleanups the daemon ran on session release (`registerRecordingSessionCleanup`):
   * the recording operations are stubbed at the device boundary and report here.
   */
  readonly recordingStops: Array<{ sessionId: string | undefined; deviceId: string }> = [];

  /**
   * Stops a session's release ran for a recording that session owns. The acquisition canceller's
   * owner-less sweep (#11035) also reports here, with no session id; it is not a release stop.
   */
  get sessionRecordingStops(): Array<{ sessionId: string; deviceId: string }> {
    return this.recordingStops.flatMap(({ sessionId, deviceId }) =>
      sessionId === undefined ? [] : [{ sessionId, deviceId }],
    );
  }
  /**
   * While true, a released session's recording stop never settles (a wedged finalize): only the
   * finalize cap frees the device, and the recording `recording-of-<session>` is marked
   * incomplete.
   */
  recordingStopHangs = false;
  /** Recordings force-stopped at the finalize cap and marked incomplete, in order. */
  readonly incompleteRecordings: string[] = [];
  /**
   * Appearance modes the daemon's own host sync applied, as `<device>:<mode>` in order: the sync
   * it starts for the device of each session it creates. The host lookup and the device command
   * are stubbed at their boundary and report here.
   */
  readonly appearanceApplies: string[] = [];
  /**
   * The daemon stops answering heartbeats (a wedged event loop on the wire): each frame hangs
   * until the end of the scenario, except that the first is accepted `lateAckDelayMs` after it
   * was sent when that is set (#10973, a late ack). Clear it to answer again.
   */
  daemonStall: { lateAckDelayMs?: number; lateAckTaken?: boolean } | undefined;
  /** While true, the transport silently loses every heartbeat frame (the proxy sees an ack). */
  dropHeartbeats = false;
  daemon!: DaemonSide;
  proxy!: DaemonMcpProxy;
  private readonly autolock: boolean;
  private readonly sharedDeviceClaims: boolean;
  private readonly discovery = new FakeDeviceUtils();
  private tools!: RealToolCallPath;
  private readonly spies: Array<ReturnType<typeof spyOn>> = [];
  private readonly savedEnv = new Map<string, string | undefined>();
  private readonly gates = new Map<string, { opened: Promise<void>; wedged: boolean }>();
  private unsubscribeReleaseBroadcast: (() => void) | undefined;
  private restoreRecordingDeps: (() => void) | undefined;
  private restoreAppearanceDeps: (() => void) | undefined;
  private minted: string | undefined;
  private mintCount = 0;
  private daemonCount = 0;
  /** Raw-frame clients (desktop, JUnit, `--cli`) by connection name. */
  private readonly rawClients = new Map<string, RawFrameClient>();
  /** The stdio proxy's current client per connection: a second socket would replace its own. */
  private redials = 0;
  /** The socket each connection name was last dialed on, to tell a second dial from the first. */
  private readonly dialed = new Map<string, InMemoryClientSocket>();
  private readonly proxyClients = new Map<string, InMemoryDaemonClient>();
  private readonly proxies: DaemonMcpProxy[] = [];
  private readonly connections: DaemonClientLike[] = [];

  private constructor(options: LivenessScenarioOptions) {
    this.deviceIds = options.devices ?? ["emulator-5554"];
    this.autolock = options.autolock ?? false;
    this.sharedDeviceClaims = options.sharedDeviceClaims ?? false;
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
      // The daemon records a device's display settings before a session changes them (#11145),
      // reading them over adb. The device reports nothing here, as a host without it would.
      spyOn(DefaultDeviceSettingsAccess.prototype, "read").mockResolvedValue({}),
      spyOn(DefaultDeviceSettingsAccess.prototype, "write").mockResolvedValue([]),
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
    // The real Daemon builds its pool with the process-wide device manager: serve the fake.
    PlatformDeviceManagerFactory.setInstance(this.discovery);
    this.stubRecordingDevice();
    this.stubAppearanceSync();
    this.tools = new RealToolCallPath(this.deviceIds.map((id) => this.device(id))).install();
    // A long call stays in flight at the device boundary until the scenario settles it.
    this.tools.setBody(async (input) => {
      const sessionUuid = input.args?.sessionUuid;
      const gate = this.gates.get(sessionUuid);
      // A call told to stop (the daemon cancelled its execution, #10820, or its request passed
      // its deadline) leaves its body at once, unless its device command is wedged.
      const stopped = new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await (gate?.wedged ? gate.opened : Promise.race([gate?.opened, stopped]));
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    });
    this.unsubscribeReleaseBroadcast = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      this.releaseBroadcasts.push({ at: this.timer.now(), sessionId, reason: reason ?? "" });
    });
    this.daemon = await this.createDaemonSide();
    this.proxy = this.createProxy();
  }

  /**
   * Every session "owns a recording" at the device boundary, so a release the daemon wires to
   * recording cleanup stops it and a release it does not leaves `recordingStops` empty.
   */
  private stubRecordingDevice(): void {
    const deps = defaultRecordingSessionCleanupDeps;
    const original = { ...deps };
    deps.hasRecordingsToStop = () => true;
    // The finalize cap (#10957) runs on the scenario clock, so a hung stop is cut by advancing it.
    deps.timer = this.timer;
    deps.stopSegmentedRecordings = async (sessionId, deviceId) => {
      this.recordingStops.push({ sessionId, deviceId });
      if (this.recordingStopHangs && sessionId !== undefined) {
        await new Promise<void>(() => {});
      }
    };
    deps.activeRecordingIdsForOwner = (sessionId) =>
      this.recordingStopHangs && sessionId !== undefined ? [`recording-of-${sessionId}`] : [];
    deps.markVideoRecordingIncomplete = async (recordingId) => {
      this.incompleteRecordings.push(recordingId);
    };
    deps.listActiveVideoRecordings = async () => [];
    deps.isTestRecordingOwnedBy = () => false;
    this.restoreRecordingDeps = () => Object.assign(deps, original);
  }

  /**
   * The daemon syncs a device to the host's appearance when a session is created on it. Left
   * alone that reads the config store, runs `defaults`/`gsettings` on the host and then `adb`
   * against the device id, which on a machine with that emulator attached is a real device. The
   * decision to sync stays the daemon's; its three ends answer here instead.
   */
  private stubAppearanceSync(): void {
    const deps = defaultAppearanceSyncDependencies;
    const original = { ...deps };
    deps.getConfig = async () => ({
      syncWithHost: true,
      defaultMode: "light",
      applyOnConnect: true,
    });
    deps.resolveMode = async () => "light";
    deps.apply = async (device, mode) => {
      this.appearanceApplies.push(`${device.deviceId}:${mode}`);
    };
    this.restoreAppearanceDeps = () => Object.assign(deps, original);
  }

  /**
   * A second stdio proxy on the same daemon, e.g. a challenger naming another proxy's session.
   * `client` builds the proxy's daemon client over each new connection to the daemon, for a test
   * that puts its own client (a recorder, a `FakeDaemonClient` backed by the daemon) in between.
   */
  addProxy(config: {
    token: string;
    initialSessionUuid?: string;
    client?: (daemon: DaemonClientLike) => DaemonClientLike;
  }): DaemonMcpProxy {
    return this.createProxy(config.token, config.initialSessionUuid, config.client);
  }

  /**
   * One daemon process: a real `Daemon` started through `startOn()`, the body of `start()`
   * (#11441). Its constructor and its start sequence do all the wiring; this method only supplies
   * the device boundary, the in-memory "disk" and the steps of `start()` that touch the machine.
   */
  private async createDaemonSide(startupMs = 0): Promise<DaemonSide> {
    // One database across daemon "processes", so a restart rehydrates what the last one persisted.
    this.repository ??= new DeviceSessionRepository(await createTestDatabase(), this.timer);
    const repository = this.repository;
    // Each process has its own daemon session id, so a restart sees the last one's rows as stale.
    const daemonIds = new FakeIdGenerator([`scenario-daemon-${++this.daemonCount}`]);
    // The process's own timers: they die with it, while the proxies' run on.
    const clock = new ProcessTimer(this.timer);
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      clock,
      repository,
      daemonIds,
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
      { check: async () => {} },
      async () => {
        throw new Error("LivenessScenario: database health recovery would exit the process");
      },
      undefined,
      async () => {},
      new FakeToolSelectionProfileProvenanceLoader(),
      () => {
        throw new Error("LivenessScenario: the HTTP listener is never created");
      },
      () => 0,
      () => undefined,
      { collectLiveDaemonSessionIds: () => new Set<string>() },
      new IncumbentOwnerGuard({
        readPidFile: () => null,
        persistPidFile: () => {
          throw new Error("LivenessScenario: the PID file is never written");
        },
        isProcessRunning: () => false,
        readProcessGenerationToken: () => undefined,
        selfPid: SCENARIO_DAEMON_PID,
      }),
      () => ({ listDeviceImages: async () => [] }),
      () => NO_MANAGED_SLOTS,
      () => undefined,
    );
    armHostTripwires(daemon);
    const manager = daemon.getSessionManager();
    const pool = daemon.getDevicePool();
    // The Daemon builds its pool over the real multi-platform device manager and the forwarding
    // lease files, and takes no injection; swap the fakes in before anything discovers a device.
    const poolInternals = pool as unknown as {
      deviceManager: unknown;
      idleDeviceReaper: { deviceManager: unknown };
      foreignDeviceOwnership: unknown;
      iosForeignDeviceOwnership: unknown;
    };
    poolInternals.deviceManager = this.discovery;
    // The idle-device reaper captured the pool's device manager when the pool was built.
    poolInternals.idleDeviceReaper.deviceManager = this.discovery;
    poolInternals.foreignDeviceOwnership = this.peerAwareOwnership();
    poolInternals.iosForeignDeviceOwnership = undefined;
    manager.onSessionRelease((sessionId, deviceId, reason) => {
      this.releases.push({ at: this.timer.now(), sessionId, deviceId, reason: reason ?? "" });
    });
    let socket: InMemoryControlSocket | undefined;
    await daemon.startOn(
      this.startHost(clock, startupMs, (bound) => {
        socket = bound;
      }),
    );
    if (!socket) {
      throw new Error("LivenessScenario: Daemon.startOn() never bound its control socket");
    }
    return { daemon, manager, pool, state: DaemonState.getInstance(), socket, clock };
  }

  /**
   * The steps of `Daemon.start()` that touch the machine, for a daemon that must not: no working
   * directory change, signal handler, PID file, listener or device monitor. The journal is the
   * real per-daemon one over the scenario's in-memory data directory, and the control socket is
   * the real server accepting in-process connections.
   */
  private startHost(
    clock: ProcessTimer,
    startupMs: number,
    onSocket: (socket: InMemoryControlSocket) => void,
  ): DaemonStartHost {
    return {
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: (owner) =>
        createDaemonTerminalReleaseJournal({
          ...owner,
          dataDir: assertNotHostDaemonPath("data directory", IN_MEMORY_DATA_DIR),
          fileSystem: this.journalFiles,
        }),
      startHttpIngress: async () => {},
      sweepStaleAppearanceConfigs: async () => {},
      bindControlSocket: async () => {
        // A slow start: the work between session rehydration and the bind takes this long.
        if (startupMs > 0) {
          await clock.sleep(startupMs);
        }
        const socket = InMemoryControlSocket.attach({
          timer: clock,
          connectionIds: new FakeIdGenerator(),
          // Every tool is enabled for every session: the selection store is a database table.
          startupOptions: {
            sessionToolSelectionService: {
              isEnabled: async () => true,
              setEnabled: async () => {},
            },
          },
          loopback: loopbackMcpClientFactory(
            (name, args, requestSignal) => this.loopbackToolCall(name, args, requestSignal),
            clock,
          ),
        });
        onSocket(socket);
        return socket.server;
      },
      startServicesAfterSocketBind: async () => {},
      startMaintenanceMonitors: () => {},
    };
  }

  /** This daemon's view of the shared claim store: a claim by any other PID is foreign. */
  private peerAwareOwnership(): ForeignDeviceOwnership {
    const claims = this.deviceClaims;
    const beforeClaim = (deviceId: string) => this.beforeDeviceClaim?.(deviceId);
    return {
      async refresh(): Promise<void> {},
      foreignOwnerPid(deviceId: string): number | undefined {
        const owner = claims.get(deviceId);
        return owner === undefined || owner === SCENARIO_DAEMON_PID ? undefined : owner;
      },
      async claim(deviceId: string): Promise<boolean> {
        beforeClaim(deviceId);
        const owner = claims.get(deviceId);
        if (owner !== undefined && owner !== SCENARIO_DAEMON_PID) {
          return false;
        }
        claims.set(deviceId, SCENARIO_DAEMON_PID);
        return true;
      },
      release(deviceId: string): void {
        if (claims.get(deviceId) === SCENARIO_DAEMON_PID) {
          claims.delete(deviceId);
        }
      },
    };
  }

  /** A client dials the daemon that is running now; a restart is a new daemon to dial. */
  private dial(connection: string): InMemoryClientSocket | undefined {
    // The daemon keys a socket by its connection, so a dial while the name's socket is still open
    // (a recovery probe, a reconnect before the old socket is gone) is a new connection of its own.
    const open = this.dialed.get(connection);
    const name = open && !open.destroyed ? `${connection}#${++this.redials}` : connection;
    const socket = this.daemon.socket.connect(name);
    if (socket && name === connection) {
      this.dialed.set(connection, socket);
    }
    return socket;
  }

  /** The stdio proxy exactly as src/index.ts builds it: default lease, owner token, own keeper. */
  private createProxy(
    token = OWNER_TOKEN,
    initialSessionUuid?: string,
    client?: (daemon: DaemonClientLike) => DaemonClientLike,
  ): DaemonMcpProxy {
    // Each proxy is its own daemon socket connection.
    const connection = token === OWNER_TOKEN ? CONNECTION : `scenario-connection:${token}`;
    const heartbeats = {
      dropped: () => this.dropHeartbeats,
      stall: async () => {
        // A wedged daemon event loop (#10973): the frame hangs, or is accepted late once.
        const stall = this.daemonStall;
        if (!stall) {
          return;
        }
        if (stall.lateAckDelayMs === undefined || stall.lateAckTaken) {
          await new Promise<void>(() => {});
        }
        stall.lateAckTaken = true;
        await new Promise<void>((resolve) => this.timer.setTimeout(resolve, stall.lateAckDelayMs));
      },
      delivered: (params: Record<string, unknown>) => {
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
      },
    };
    const proxy = new DaemonMcpProxy({
      // A new client per connection attempt, as src/index.ts builds one.
      clientFactory: () => {
        if (client) {
          return client(this.daemonConnection(connection));
        }
        const proxyClient = new ScenarioDaemonClient(
          () => this.dial(connection),
          this.timer,
          heartbeats,
        );
        this.proxyClients.set(connection, proxyClient);
        return proxyClient;
      },
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer: this.timer,
      idGenerator: new FakeIdGenerator(),
      livenessOwnerToken: token,
      heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
      ...(initialSessionUuid ? { initialSessionUuid } : {}),
    });
    this.proxies.push(proxy);
    return proxy;
  }

  /**
   * One forwarded `tools/call` as the daemon's MCP entry answers it. The entry is the one hop
   * behind the socket server this harness stands in for.
   */
  private async loopbackToolCall(
    name: string,
    args: Record<string, unknown>,
    requestSignal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.runDeviceTool(name, args, requestSignal);
    } finally {
      // Let the call's end reach the daemon's activity wiring before the response is framed.
      await drainMicrotasks(TURNS_PER_EVENT);
    }
  }

  /**
   * A tool call behind the socket server's forward, which stamped the connection on it.
   * `getAndroid`/`provisionDevice` acquire through the pool directly (their device work and
   * readiness setup are the device boundary) and answer in the tool's result shape; every other
   * tool runs the real registration through the real ToolRegistry path, and what it throws is
   * shaped as `src/server/index.ts`'s tool-call catch block shapes it.
   */
  private async runDeviceTool(
    tool: string,
    args: Record<string, unknown>,
    requestSignal: AbortSignal,
  ): Promise<unknown> {
    const { manager, pool } = this.daemon;
    const connection = String(args.__mcpSessionId);
    if (tool === "getAndroid" || tool === "provisionDevice") {
      const deviceId = typeof args.deviceId === "string" ? args.deviceId : this.deviceIds[0]!;
      if (this.autolock && tool === "getAndroid") {
        this.minted = await pool.autolockDevice(deviceId, PLATFORM, connection);
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
          connection,
        );
      }
      // Acquisition prepared the device, as getAndroid's readiness setup records.
      manager.setDeviceReadiness(this.minted, "automationReady");
      return tool === "provisionDevice"
        ? provisionDeviceResult(this.minted, deviceId)
        : deviceStartResult(this.minted);
    }
    try {
      return await this.tools.call(tool, args, requestSignal);
    } catch (error) {
      return toolErrorResult(error, tool);
    }
  }

  /**
   * A new connection to the scenario's daemon: the real daemon client over the in-memory control
   * socket, for a test that drives the client API itself or backs a `FakeDaemonClient` with the
   * real daemon (its `daemon` option).
   */
  daemonConnection(connection: string): DaemonClientLike {
    const client = new InMemoryDaemonClient(
      () => this.dial(connection),
      this.timer,
      new FakeIdGenerator(),
    );
    this.connections.push(client);
    return client;
  }

  private rawClient(connection: string): RawFrameClient {
    let client = this.rawClients.get(connection);
    if (!client) {
      // A frame on a proxy's connection goes out on the proxy's own socket: the daemon keys a
      // socket by its connection, so a second socket would take the proxy's place.
      client = new RawFrameClient(
        connection,
        () => this.proxyClients.get(connection)?.liveSocket ?? this.dial(connection),
      );
      this.rawClients.set(connection, client);
    }
    return client;
  }

  /**
   * One `daemon/*` frame from a client with no proxy in front (the desktop, a JUnit runner, a
   * `--cli` call), answered by the daemon's socket: the response envelope, success or not.
   */
  daemonMethod(
    method: string,
    params: Record<string, unknown> = {},
    connection = SOCKET_CLIENT_CONNECTION,
  ): Promise<WireEnvelope> {
    return this.rawClient(connection).request(method, params);
  }

  /** One `tools/call` frame from `connection`: the tool result, or what the daemon refused it with. */
  private async socketToolCall(
    tool: string,
    args: Record<string, unknown>,
    connection: string,
  ): Promise<unknown> {
    const envelope = await this.rawClient(connection).request("tools/call", {
      name: tool,
      arguments: args,
    });
    if (!envelope.success) {
      throw new DaemonRequestFailed(envelope);
    }
    if (isErrorResult(envelope.result)) {
      throw new ToolCallRefused(errorResultText(envelope.result), envelope.result);
    }
    return envelope.result;
  }

  // ---- events -------------------------------------------------------------------------------

  /** Advance virtual time, letting each due event's async work (a keeper round trip) settle. */
  async idle(ms: number): Promise<void> {
    await this.timer.advanceTimeAsync(ms, () => drainMicrotasks(TURNS_PER_EVENT));
  }

  /** The agent's getAndroid: acquires `deviceId` and returns the session UUID the daemon minted. */
  async acquire(deviceId: string = this.deviceIds[0]!): Promise<string> {
    await this.proxyToolCall("getAndroid", { deviceId });
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
      DESKTOP_CONNECTION,
    );
    return sessionId;
  }

  /**
   * A device tool call on `sessionId` that settles at once. The default is a control call: no read
   * counts as activity, not even the owner's own (#10964).
   */
  async toolCall(sessionId: string, tool = CONTROL_TOOL): Promise<unknown> {
    return await this.proxyToolCall(tool, { sessionUuid: sessionId });
  }

  /**
   * A tool call through the stdio proxy as its MCP client sees it: the result, or a rejection for
   * a call the proxy threw on or answered with an `isError` result ({@link ToolCallRefused}).
   */
  private async proxyToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.proxy.callTool(tool, args);
    if (isErrorResult(result)) {
      throw new ToolCallRefused(errorResultText(result), result);
    }
    return result;
  }

  /**
   * A device tool call that reaches the daemon with no stdio proxy in front of it (a `--cli` call,
   * the desktop or a JUnit runner over the socket): the proxy's own released-session refusal does
   * not apply, so the daemon's admission decides.
   */
  async daemonToolCall(sessionId: string, tool = CONTROL_TOOL): Promise<unknown> {
    return await this.socketToolCall(tool, { sessionUuid: sessionId }, SOCKET_CLIENT_CONNECTION);
  }

  /**
   * A daemon-side tool call with exactly these arguments (no proxy in front, no routing markers),
   * forwarded on `connection` (by default a socket client that acquired nothing).
   */
  async daemonToolCallWith(
    args: Record<string, unknown>,
    tool = "observe",
    connection = SOCKET_CLIENT_CONNECTION,
  ): Promise<unknown> {
    return await this.socketToolCall(tool, args, connection);
  }

  /**
   * One frame from the desktop/IDE client (`ide/*`, `input/*`, `appearance/*`) on its own
   * connection to the daemon's control socket, answered by the started daemon's socket server.
   */
  socketFrame(method: string, params: Record<string, unknown>): Promise<WireEnvelope> {
    return this.daemonMethod(method, params, IDE_FRAME_CONNECTION);
  }

  /**
   * `set_appearance` on the appearance socket as `sessionUuid` (none: a caller with no session),
   * answered by the real {@link AppearanceSocketServer} over this daemon's session ownership.
   * Resolves with the response and the devices the mode was applied to.
   */
  async appearanceSet(
    sessionUuid: string | undefined,
    mode: "light" | "dark",
  ): Promise<{ response: AppearanceSocketResponse; applied: string[] }> {
    const applied: string[] = [];
    let config = { syncWithHost: false, defaultMode: "light", applyOnConnect: true };
    const manager = this.daemon.manager;
    const server = new AppearanceSocketServer(
      "unused",
      this.timer,
      new SessionScopedStreamAuthenticator(() => manager, "appearance"),
      {
        getPooledDevices: () => this.deviceIds.map((id) => this.device(id) as never),
        getCurrentDevice: () => undefined,
        getSessionForDevice: (deviceId) => manager.getSessionForDevice(deviceId) ?? null,
      },
      {
        getConfig: async () => config as never,
        updateConfig: async (update) => {
          config = { ...config, ...update } as typeof config;
          return config as never;
        },
        resolveMode: async () => "light",
        applyToDevice: async (device, appliedMode) => {
          applied.push(`${device.deviceId}:${appliedMode}`);
        },
        triggerSync: async () => {},
        isSyncEnabled: () => false,
      },
    );
    const socket = new FakeSocket();
    const internals = server as unknown as {
      processLine(socket: unknown, line: string): Promise<void>;
      pendingBySocket: Map<unknown, Promise<void>>;
    };
    await internals.processLine(
      socket,
      JSON.stringify({
        id: "appearance",
        command: "set_appearance",
        sessionUuid,
        params: { mode },
      }),
    );
    await internals.pendingBySocket.get(socket);
    const response = socket.getWrittenMessages<AppearanceSocketResponse>()[0]!;
    return { response, applied };
  }

  /** Writes the device's CtrlProxy received from a socket `ide/*` frame. */
  get ctrlProxyWrites(): readonly string[] {
    return this.tools.ctrlProxyWrites;
  }

  /** The stdio proxy's own daemon connection, for calls that bypass the proxy's argument rewrite. */
  get proxyConnection(): string {
    return CONNECTION;
  }

  /** A tool call that stays in flight until `settle()`. */
  startLongCall(
    sessionId: string,
    tool = CONTROL_TOOL,
    options: {
      /**
       * The device command ignores every signal to stop (its request's deadline, the daemon's
       * cancel) and ends only on `settle()`: the execution stays in flight behind a caller that
       * was already answered with a timeout.
       */
      wedged?: boolean;
    } = {},
  ): LongCall {
    let open!: () => void;
    this.gates.set(sessionId, {
      opened: new Promise<void>((resolve) => {
        open = resolve;
      }),
      wedged: options.wedged ?? false,
    });
    let failure: unknown;
    const done = this.proxy.callTool(tool, { sessionUuid: sessionId });
    // The caller of a long call is answered with a failure when the call outlives its request
    // deadline; a scenario reads it from `failure()` rather than as an unhandled rejection.
    const answered = done.then(
      () => undefined,
      (error: unknown) => {
        failure = error;
      },
    );
    return {
      done,
      failure: () => failure,
      settle: async () => {
        open();
        this.gates.delete(sessionId);
        await answered;
        await drainMicrotasks(TURNS_PER_EVENT);
      },
    };
  }

  /**
   * The desktop/IDE client as `test/fixtures/desktop-wire/<name>.json` records it (#10669): replays
   * the fixture's `daemon/*` frames from the desktop and the probe, at the recorded times (a
   * repeated frame at its `everyMs`), against this scenario's real daemon, so the cadence and
   * shape are the checked-in wire contract rather than a hand-written loop. Returns each
   * response that differs from the recorded one (`expiresAtMs` is relative to the replay start)
   * and the labels of the frames it could not drive (`tools/call`, `input/*`), which need the
   * socket and tool-call path of the wire harness.
   */
  async replayDesktopFixture(
    name: string,
  ): Promise<{ mismatches: string[]; skipped: string[]; finishedAtMs: number }> {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "desktop-wire", `${name}.json`), "utf8"),
    ) as WireFixture;
    const startedAt = this.timer.now();
    const mismatches: string[] = [];
    const skipped: string[] = [];
    for (const exchange of fixture.exchanges) {
      const method = exchange.request.method;
      if (!method.startsWith("daemon/") || exchange.actor === "agent") {
        skipped.push(exchange.label);
        continue;
      }
      for (let beat = 0; beat < (exchange.repeat ?? 1); beat++) {
        const dueAt = startedAt + exchange.atMs + beat * (exchange.everyMs ?? 0);
        if (dueAt > this.timer.now()) {
          await this.idle(dueAt - this.timer.now());
        }
        const response = await this.daemonMethod(
          method,
          exchange.request.params,
          `scenario-${exchange.actor}`,
        );
        const actual = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
        const result = actual.result as Record<string, unknown> | undefined;
        if (typeof result?.expiresAtMs === "number") {
          result.expiresAtMs -= startedAt;
        }
        if (JSON.stringify(actual) !== JSON.stringify(exchange.response)) {
          mismatches.push(`${exchange.label}#${beat}: ${JSON.stringify(actual)}`);
        }
      }
    }
    return { mismatches, skipped, finishedAtMs: this.timer.now() - startedAt };
  }

  /**
   * The daemon's event loop is blocked for `ms` (a long GC, a synchronous DB call): the wall AND
   * monotonic clocks run on, no timer fires, so the monitor scan and the owner's queued keeper
   * heartbeats all come due at once and are delivered late on the next advance (#10662). The lost
   * time is the daemon's, not the owner's, so the monitor must forgive it.
   */
  lateTicks(ms: number): void {
    this.timer.setCurrentTime(this.timer.now() + ms);
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
      void this.daemonMethod("daemon/heartbeat", { sessionId }, DESKTOP_CONNECTION);
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
      void this.daemonMethod(
        "daemon/heartbeat",
        {
          sessionId,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
          livenessOwnerToken: token,
          ...(claimed ? {} : { claimLivenessOwnership: true }),
        },
        CLI_KEEPER_CONNECTION,
      );
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

  /**
   * A device tool call the agent routes by `deviceId`, with no session UUID. A control call by
   * default: a read is watching, which the proxy never credits as use (#10964, #10974).
   */
  async selectorCall(
    deviceId: string,
    tool = "rotate",
    args: Record<string, unknown> = { orientation: "portrait" },
  ): Promise<void> {
    await this.proxyToolCall(tool, { ...args, deviceId });
  }

  /**
   * An agent acquires through `provisionDevice` (result shape `{device, sessionId}`) instead of
   * `getAndroid`, returning the session UUID the daemon minted.
   */
  async provision(deviceId: string = this.deviceIds[0]!): Promise<string> {
    await this.proxyToolCall("provisionDevice", { deviceId });
    await drainMicrotasks(TURNS_PER_EVENT);
    return this.minted!;
  }

  /**
   * Times a tool call readied a device (`ensureDeviceReady`, the call that touches the device).
   * A refused call must not add to it: "refuse before readiness" (#10828).
   */
  get readinessTouches(): number {
    return this.tools.deviceSessionManager.getEnsureDeviceReadyCalls();
  }

  /** Devices the read-only watcher path resolved, and captured, without a session (#10830). */
  get watched(): { resolutions: number; reads: readonly string[] } {
    return { resolutions: this.tools.watcherResolutions, reads: this.tools.watcherReads };
  }

  /**
   * The devices the running daemon lets host appearance sync touch: the scope `Daemon.start()`
   * hands the scheduler (`startAppearanceSyncScheduler({ getTargets })`).
   */
  appearanceSyncTargets(): AppearanceSyncTarget[] {
    return (
      this.daemon.daemon as unknown as { getAppearanceSyncTargets(): AppearanceSyncTarget[] }
    ).getAppearanceSyncTargets();
  }

  /** Tool bodies that reached the device boundary (what actually drove a device). */
  get driven(): readonly DeviceToolRun[] {
    return this.tools.runs;
  }

  /** The MCP host closes the proxy's stdin: the keeper stops and the connection drops. */
  async closeTransport(): Promise<void> {
    await this.proxy.close();
    await drainMicrotasks(TURNS_PER_EVENT);
  }

  /**
   * The daemon process dies and a new one starts: the old process's memory, timers and
   * connections are gone with nothing written on the way out, and the new process runs
   * `Daemon.startOn()` over the same database and journal directory. Its start sequence expires
   * the dead process's rows, rehydrates them awaiting their owners, and opens their owner
   * windows. A proxy that is still running sees its connection drop and reconnects.
   *
   * `startupMs` makes it a slow start: that much time passes between the new process's session
   * rehydration and its control socket accepting connections, with no daemon to reach meanwhile.
   */
  async daemonRestart(options: { startupMs?: number } = {}): Promise<void> {
    this.killDaemonSide(this.daemon);
    const startupMs = options.startupMs ?? 0;
    if (startupMs === 0) {
      this.daemon = await this.createDaemonSide();
      return;
    }
    let started: DaemonSide | undefined;
    const starting = this.createDaemonSide(startupMs).then((side) => {
      started = side;
    });
    // The start reaches its slow step a few turns in; step the clock until it is through.
    const giveUpAt = this.timer.now() + startupMs + SLOW_START_STEP_MS * 10;
    while (!started && this.timer.now() < giveUpAt) {
      await drainMicrotasks(SLOW_START_TURNS);
      await this.idle(SLOW_START_STEP_MS);
    }
    await Promise.race([starting, drainMicrotasks(SLOW_START_TURNS)]);
    if (!started) {
      throw new Error("LivenessScenario: the slow start never finished");
    }
    this.daemon = started;
  }

  /** The process is gone: its connections drop and none of its timers fires again. */
  private killDaemonSide(side: DaemonSide): void {
    side.socket.kill();
    side.clock.kill();
    (side.daemon as unknown as DaemonProcessTeardown).stopSessionTimers();
  }

  async stop(): Promise<void> {
    for (const proxy of this.proxies.splice(0)) {
      await proxy.close();
    }
    for (const connection of this.connections.splice(0)) {
      await connection.close();
    }
    for (const client of this.rawClients.values()) {
      client.close();
    }
    this.rawClients.clear();
    this.killDaemonSide(this.daemon);
    this.tools.uninstall();
    PlatformDeviceManagerFactory.reset();
    this.restoreRecordingDeps?.();
    this.restoreAppearanceDeps?.();
    this.unsubscribeReleaseBroadcast?.();
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

  /**
   * Every terminal-release intent on the scenario's "disk", across the journals of every daemon
   * process: what a restarted daemon would adopt.
   */
  journaledIntents(): string {
    return Array.from(this.journalFiles.files.values()).join("");
  }

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
        const releasedAt = this.timer.now();
        // The probe may itself start the lazy expiry. An idle release is terminal (#11258) and
        // writes its row before it notifies, so let it reach `releases` before returning.
        await this.daemon.manager.waitForSessionRelease(sessionId);
        return releasedAt;
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
