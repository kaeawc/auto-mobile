import type { Kysely } from "kysely";
import { DAEMON_DEVICE_LEASE_STATUS_METHOD } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { registerDerivedLabelSessionReleaseCascade } from "../../src/daemon/derivedLabelSessionReleaseCascade";
import type { DeviceLeaseActivitySources } from "../../src/daemon/deviceLeaseActivity";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { PROXY_HEARTBEAT_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  createDaemonTerminalReleaseJournal,
  TERMINAL_RELEASE_JOURNAL_DIR_NAME,
  type TerminalReleaseJournalDirectory,
} from "../../src/daemon/terminalReleaseJournal";
import type { Database } from "../../src/db/types";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { ForwardLeaseOwnerProbe } from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import type { BootedDevice } from "../../src/models";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleTargetNotHeldByOtherDaemon,
} from "../../src/server/lifecycleDeviceOwnership";
import { deviceLossCancellationReason } from "../../src/utils/deviceLossCancellationReason";
import { errorMessage } from "../../src/utils/describeUnknownError";
import type { LockContent } from "../../src/utils/fileLock";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";
import { createDevicePoolDependencies } from "./devicePoolDependencies";
import { drainMicrotasks } from "./fakeTimerStepping";
import { isExpectedRefusal, processTimer } from "./poolOwnershipConcurrencyHarness";

// Two-daemon mode of the seeded ownership harness (poolOwnershipConcurrencyHarness.ts). Two daemon
// "processes", each a real SessionManager + DevicePool + SessionHeartbeatMonitor wired as daemon.ts
// wires them, share what two daemons on one host share:
//   - one SQLite database (an in-memory migrated DB behind the real DeviceSessionRepository),
//   - one adb server's devices (one fake discovery source),
//   - the per-device allocation claim files (an in-memory lock store with fileLock's semantics,
//     read and written by the real ForwardLeaseForeignDeviceOwnership of each daemon),
//   - each other's control socket: a peer's claim is probed in-process by asking the owning
//     daemon's real `daemon/deviceLeaseStatus` handler,
//   - the data directory's per-daemon terminal-release journal files (#11169), created through the
//     real createDaemonTerminalReleaseJournal with startup adoption of dead daemons' files.
// A daemon can crash (its timers, DB writes, claim and journal writes stop; its rows, claims and
// journal stay), stop gracefully, and start again: the startup runs daemon.ts's order (stale-row
// sweep with the live peer set, journal adoption, pool init, rehydration, socket bind) as an
// in-flight operation that interleaves with the peer's work. A daemon's terminal-release DB writes
// can be wedged so its journal holds unconfirmed intents when it, or its peer, restarts.
//
// Invariants (cross-daemon; per-daemon ones are the single-daemon harness's job):
//   - device-two-daemons: at a settle point a device is assigned in at most one live daemon.
//   - unclaimed-assignment: at a settle point a device a live daemon assigns carries its claim.
//   - kill-foreign-device: a daemon never kills (retires from adb) a device a live peer holds.
//   - foreign-session-revived: a daemon never creates or rehydrates a session live in its peer.
//   - peer-row-expired: a daemon's startup never moves a live peer's live session row off active.
//   - peer-journal-touched: a daemon never writes or removes a live peer's journal file.
//   - live-row-not-owned: at a settle point a daemon's live session has an active row stamped
//     with that daemon's id.

export const TWO_DAEMON_DEVICE_COUNT = 3;
export const TWO_DAEMON_CLIENT_COUNT = 4;
const DAEMON_NAMES = ["A", "B"] as const;
const DATA_DIR = "/automobile-data";

const DEVICES: readonly BootedDevice[] = Array.from(
  { length: TWO_DAEMON_DEVICE_COUNT },
  (_, i) => ({
    deviceId: `emulator-${5554 + i * 2}`,
    name: `Pixel_8_API_35_${i}`,
    platform: "android" as const,
  }),
);

/** AUTOMOBILE_TWO_DAEMON_TRACE=1 streams the trace to stderr as it is written. */
const STREAM_TRACE = process.env.AUTOMOBILE_TWO_DAEMON_TRACE === "1";

const SETTLE_TURNS = 300;
const SETTLE_TIME_NUDGES = 400;
const SETTLE_NUDGE_MS = 1_000;

export type TwoDaemonStepKind =
  | "acquire"
  | "acquireAny"
  | "release"
  | "control"
  | "loseHeartbeat"
  | "resumeHeartbeat"
  | "advance"
  | "monitorTick"
  | "cleanupSweep"
  | "kill"
  | "disconnect"
  | "reconnect"
  | "wedge"
  | "unwedge"
  | "crash"
  | "stop"
  | "start"
  | "settle";

export interface TwoDaemonStep {
  kind: TwoDaemonStepKind;
  /** Daemon index (0 = A, 1 = B) a daemon-scoped step targets, and an acquire goes through. */
  daemon: number;
  client: number;
  device: number;
  ms: number;
  turns: number;
}

export interface TwoDaemonProfile {
  steps: number;
  weights: Partial<Record<TwoDaemonStepKind, number>>;
}

const ADVANCE_CHOICES_MS = [250, PROXY_HEARTBEAT_INTERVAL_MS, 5_000, 30_000, 65_000] as const;
const TURN_CHOICES = [0, 0, 1, 2, 3, 5, 8, 13, 40] as const;

export function generateTwoDaemonSteps(seed: number, profile: TwoDaemonProfile): TwoDaemonStep[] {
  const random = new SeededRandom(seed);
  const table = Object.entries(profile.weights).flatMap(([kind, weight]) =>
    Array.from({ length: weight ?? 0 }, () => kind as TwoDaemonStepKind),
  );
  return Array.from({ length: profile.steps }, () => ({
    kind: random.pick(table),
    daemon: Math.floor(random.next() * DAEMON_NAMES.length),
    client: Math.floor(random.next() * TWO_DAEMON_CLIENT_COUNT),
    device: Math.floor(random.next() * TWO_DAEMON_DEVICE_COUNT),
    ms: random.pick(ADVANCE_CHOICES_MS),
    turns: random.pick(TURN_CHOICES),
  }));
}

export function describeTwoDaemonStep(step: TwoDaemonStep, index: number): string {
  const daemon = DAEMON_NAMES[step.daemon];
  const target = (() => {
    switch (step.kind) {
      case "advance":
        return `${step.ms}ms`;
      case "acquire":
        return `c${step.client} ${daemon} d${step.device}`;
      case "acquireAny":
        return `c${step.client} ${daemon}`;
      case "kill":
        return `${daemon} d${step.device} by c${step.client}`;
      case "disconnect":
      case "reconnect":
        return `d${step.device}`;
      case "monitorTick":
      case "cleanupSweep":
      case "wedge":
      case "unwedge":
      case "crash":
      case "stop":
      case "start":
        return daemon;
      default:
        return `c${step.client}`;
    }
  })();
  return `#${index} ${step.kind} ${target} +${step.turns}t`;
}

export type TwoDaemonViolationKind =
  | "device-two-daemons"
  | "unclaimed-assignment"
  | "kill-foreign-device"
  | "foreign-session-revived"
  | "peer-row-expired"
  | "peer-journal-touched"
  | "live-row-not-owned"
  | "unsettled-operation"
  | "unexpected-error";

export interface TwoDaemonViolation {
  step: number;
  kind: TwoDaemonViolationKind;
  message: string;
}

export interface TwoDaemonRunOptions {
  tolerate?: ReadonlySet<TwoDaemonViolationKind>;
}

export interface TwoDaemonRunResult {
  violation: TwoDaemonViolation | undefined;
  trace: string[];
}

interface ClientState {
  readonly index: number;
  /** The daemon the client's session lives in. */
  daemon: number;
  connection: string | undefined;
  generation: number;
  alive: boolean;
  sessionId: string | undefined;
  ownerToken: string;
  needsClaim: boolean;
}

/** One daemon process incarnation. */
interface DaemonProcess {
  readonly name: string;
  readonly index: number;
  readonly pid: number;
  readonly daemonSessionId: string;
  readonly socketPath: string;
  dead: boolean;
  /** The control socket is bound: startup finished. */
  listening: boolean;
  manager: SessionManager;
  pool: DevicePool;
  monitor: SessionHeartbeatMonitor;
  state: DaemonStateAccess;
  /** Terminal-release DB writes parked while wedged; flushed by `unwedge`. */
  wedged: boolean;
  parked: Array<() => void>;
}

/** A promise that never settles: the continuation of work a dead process never finishes. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** The in-memory lock store with fileLock's acquire / take-over / owner-checked release. */
class SharedClaimFiles {
  readonly files = new Map<string, LockContent>();

  constructor(private readonly isRunning: (pid: number) => boolean) {}

  claimPath(deviceId: string): string {
    return `/claims/${deviceId}.lock`;
  }

  /** One process's view; a dead process's writes never happen. */
  forProcess(process: () => DaemonProcess): DeviceOwnershipFileSource {
    const files = this.files;
    const isRunning = this.isRunning;
    return {
      leasePath: () => undefined,
      claimPath: (deviceId) => this.claimPath(deviceId),
      legacyClaimPath: () => undefined,
      read: (path) => files.get(path),
      isProcessRunning: (pid) => isRunning(pid),
      tryAcquire: (path, owner) => {
        if (process().dead) {
          return false;
        }
        const held = files.get(path);
        if (held && !Number.isNaN(held.pid) && held.pid !== owner.pid && isRunning(held.pid)) {
          return false;
        }
        if (held && held.pid === owner.pid) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      takeOver: (path, observed, owner) => {
        if (process().dead) {
          return false;
        }
        const held = files.get(path);
        if (held?.pid !== observed.pid || held.token !== observed.token) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      release: (path, owner) => {
        if (process().dead) {
          return;
        }
        const held = files.get(path);
        if (held?.pid === owner.pid && held.token === owner.ownerToken) {
          files.delete(path);
        }
      },
    };
  }
}

class TwoDaemonWorld {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tolerate: ReadonlySet<TwoDaemonViolationKind>,
  ) {
    this.repository = new DeviceSessionRepository(db, this.timer);
  }

  readonly timer = new FakeTimer();
  readonly discovery = new FakeDeviceUtils();
  readonly journalFiles = new FakeTerminalReleaseJournalFileSystem();
  readonly claims = new SharedClaimFiles((pid) => this.isPidRunning(pid));
  readonly trace: string[] = [];
  private readonly repository: DeviceSessionRepository;
  readonly online: boolean[] = DEVICES.map(() => true);
  readonly clients: ClientState[] = Array.from({ length: TWO_DAEMON_CLIENT_COUNT }, (_, index) => ({
    index,
    daemon: 0,
    connection: undefined,
    generation: 0,
    alive: true,
    sessionId: undefined,
    ownerToken: `owner-${index}`,
    needsClaim: true,
  }));
  /** Current incarnation per daemon slot. */
  readonly daemons: DaemonProcess[] = [];
  private readonly allProcesses: DaemonProcess[] = [];
  /** In-flight operations and the process running each (undefined: the host, e.g. adb). */
  private readonly inflight = new Map<Promise<void>, DaemonProcess | undefined>();
  private nextPid = 40_000;
  private readonly generations = [0, 0];
  private sessionCounter = 0;
  violation: TwoDaemonViolation | undefined;
  stepIndex = -1;

  private isPidRunning(pid: number): boolean {
    return this.allProcesses.some((p) => p.pid === pid && !p.dead);
  }

  private onlineDevices(): BootedDevice[] {
    return DEVICES.filter((_, i) => this.online[i]);
  }

  private peerOf(process: DaemonProcess): DaemonProcess | undefined {
    const peer = this.daemons[1 - process.index];
    return peer && !peer.dead ? peer : undefined;
  }

  log(line: string): void {
    this.trace.push(`t=${this.timer.now()} ${line}`);
    if (STREAM_TRACE) {
      // Opt-in live trace for diagnosing a hanging seed, whose report never prints.
      process.stderr.write(`t=${this.timer.now()} ${line}\n`);
    }
  }

  fail(kind: TwoDaemonViolationKind, message: string): void {
    if (this.tolerate.has(kind)) {
      this.log(`  tolerated ${kind}: ${message}`);
      return;
    }
    if (!this.violation) {
      this.violation = { step: this.stepIndex, kind, message };
      this.log(`  VIOLATION ${kind}: ${message}`);
    }
  }

  launch(label: string, operation: () => Promise<void>, owner?: DaemonProcess): void {
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
    this.inflight.set(run, owner);
    void run.finally(() => this.inflight.delete(run));
  }

  // ---------------------------------------------------------------------------------------------
  // Process wiring

  /** The shared repository as one process sees it: a dead process's writes never land. */
  private processPersistence(process: () => DaemonProcess): DeviceSessionRepository {
    const repository = this.repository;
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          const owner = process();
          if (owner.dead) {
            return never();
          }
          const run = () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (property === "markReleased" && owner.wedged) {
            // A wedged SQLite writer: the terminal write waits until the wedge clears.
            return new Promise((resolve, reject) => {
              owner.parked.push(() => {
                if (owner.dead) {
                  return;
                }
                run().then(resolve, reject);
              });
            });
          }
          // A process that died meanwhile never sees the outcome, success or failure.
          return run().then(
            (result) => (owner.dead ? never() : result),
            (error: unknown) => (owner.dead ? never() : Promise.reject(error)),
          );
        };
      },
    });
  }

  /** The shared journal directory as one process sees it; flags writes to a live peer's file. */
  private processJournalFiles(process: () => DaemonProcess): TerminalReleaseJournalDirectory {
    const files = this.journalFiles;
    const guard = (filePath: string, operation: string): boolean => {
      const owner = process();
      if (owner.dead) {
        return false;
      }
      this.log(`  ${owner.name} journal ${operation} ${filePath}`);
      const peer = this.peerOf(owner);
      const prefix = `${DATA_DIR}/${TERMINAL_RELEASE_JOURNAL_DIR_NAME}/`;
      if (peer && filePath.startsWith(prefix)) {
        const fileOwner = decodeURIComponent(filePath.slice(prefix.length).replace(/\.jsonl$/, ""));
        if (fileOwner === peer.daemonSessionId) {
          this.fail(
            "peer-journal-touched",
            `${owner.name} (${owner.daemonSessionId}) ${operation} live peer ${peer.name}'s journal ${filePath}`,
          );
        }
      }
      return true;
    };
    return {
      listNames: (dirPath) => files.listNames(dirPath),
      readText: (filePath) => files.readText(filePath),
      appendDurable: (filePath, text) => {
        if (guard(filePath, "appended to")) {
          files.appendDurable(filePath, text);
        }
      },
      replaceDurable: (filePath, text) => {
        if (guard(filePath, "replaced")) {
          files.replaceDurable(filePath, text);
        }
      },
      remove: (filePath) => {
        if (guard(filePath, "removed")) {
          files.remove(filePath);
        }
      },
    };
  }

  /** The control socket of whichever live, listening incarnation serves `socketPath`. */
  private readonly probe: ForwardLeaseOwnerProbe = {
    query: async (socketPath, deviceId) => {
      const server = this.daemons.find(
        (p) => p && !p.dead && p.listening && p.socketPath === socketPath,
      );
      if (!server) {
        return { kind: "unreachable", detail: `ENOENT ${socketPath}` };
      }
      const response = await handleDaemonRequest(
        {
          id: `lease-${deviceId}`,
          type: "daemon_request",
          method: DAEMON_DEVICE_LEASE_STATUS_METHOD,
          params: { deviceId },
        },
        server.state,
      );
      if (!response.success) {
        return { kind: "unsupported", detail: response.error ?? "failed" };
      }
      const result = response.result as { sessionId: string | null; activeExecutions: number };
      return {
        kind: "status",
        status: {
          // The handler reports process.pid; in-process, the serving incarnation's fake PID.
          pid: server.pid,
          deviceId,
          sessionId: result.sessionId,
          activeExecutions: result.activeExecutions,
          idleForMs: null,
        },
      };
    },
  };

  private createProcess(index: number): DaemonProcess {
    const name = DAEMON_NAMES[index]!;
    const generation = ++this.generations[index]!;
    // The process's collaborators reach it lazily (only once it is built) through this cell.
    const cell: { process?: DaemonProcess } = {};
    const current = (): DaemonProcess => {
      if (!cell.process) {
        throw new Error("daemon process used before it was built");
      }
      return cell.process;
    };
    const timer = processTimer(this.timer, () => current().dead);
    const persistence = this.processPersistence(current);
    const manager = new SessionManager(timer, persistence);
    const daemonSessionId = `daemon-${name}-${generation}`;
    manager.attachDaemonSessionId(daemonSessionId);
    // Like the daemon's pid-file listing: an incarnation is listed from its start until it dies.
    manager.attachLiveDaemonSessionIds(
      () => new Set(this.daemons.filter((p) => p && !p.dead).map((p) => p!.daemonSessionId)),
    );
    const pid = ++this.nextPid;
    const socketPath = `/sockets/${name}.sock`;
    const ownership = new ForwardLeaseForeignDeviceOwnership(
      pid,
      this.claims.forProcess(current),
      this.probe,
      () => socketPath,
      timer,
    );
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, daemonSessionId, {
        timer,
        deviceManager: this.discovery,
        idGenerator: new FakeIdGenerator(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        foreignDeviceOwnership: ownership,
        env: { ...process.env },
      }),
    );
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
    const registry = new DeviceSessionRegistry();
    const sources: DeviceLeaseActivitySources = {
      sessionForDevice: (id) =>
        manager.getSessionForDevice(id) ?? pool.getDevice(id)?.sessionId ?? null,
      activeExecutionCount: () => 0,
      toolIdleForMs: () => null,
      hasStreamSubscriber: () => false,
      clientActivity: () => ({ inFlightRequests: 0, idleForMs: null }),
    };
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => registry,
      getDeviceLeaseActivitySources: () => sources,
    };
    const self: DaemonProcess = {
      name: `${name}${generation}`,
      index,
      pid,
      daemonSessionId,
      socketPath,
      dead: false,
      listening: false,
      manager,
      pool,
      monitor,
      state,
      wedged: false,
      parked: [],
    };
    cell.process = self;
    manager.onSessionCreated((session) => {
      if (self.dead) {
        return;
      }
      const peer = this.peerOf(self);
      if (peer?.manager.getAllSessions().some((s) => s.sessionId === session.sessionId)) {
        this.fail(
          "foreign-session-revived",
          `${self.name} created/rehydrated ${session.sessionId} on ${session.assignedDevice}, ` +
            `which live peer ${peer.name} holds on ` +
            `${peer.manager.getAllSessions().find((s) => s.sessionId === session.sessionId)?.assignedDevice}`,
        );
      }
      this.log(`  ${self.name} session ${session.sessionId} live on ${session.assignedDevice}`);
    });
    manager.onSessionRelease((sessionId, deviceId, reason, _snapshot, options) => {
      if (self.dead || options?.upgradeOnly) {
        return;
      }
      this.log(`  ${self.name} release ${sessionId}@${deviceId} reason=${reason}`);
    });
    this.allProcesses.push(self);
    return self;
  }

  /**
   * daemon.ts start(), in order: live-peer discovery, stale-row sweep, journal adoption, pool
   * init, rehydration, socket bind, owner windows and heartbeat monitor. Runs in flight.
   */
  private startProcess(index: number): void {
    const process = this.createProcess(index);
    this.daemons[index] = process;
    const live = new Set(
      this.daemons.filter((p) => p && p !== process && !p.dead).map((p) => p.daemonSessionId),
    );
    this.log(
      `${process.name} starting (pid ${process.pid}, live peers ${[...live].join(",") || "none"})`,
    );
    this.launch(
      `${process.name} startup`,
      async () => {
        const peer = this.peerOf(process);
        const peerRowsBefore = peer ? await this.liveActiveRows(peer) : new Set<string>();
        await this.processPersistence(() => process).markStaleActiveSessionsExpired(
          process.daemonSessionId,
          process.manager.sessionNow(),
          "daemon-restart",
          live,
        );
        process.manager.attachTerminalReleaseJournal(
          createDaemonTerminalReleaseJournal({
            daemonSessionId: process.daemonSessionId,
            liveDaemonSessionIds: live,
            dataDir: DATA_DIR,
            fileSystem: this.processJournalFiles(() => process),
          }),
        );
        await process.pool.initializeWithDevices(this.onlineDevices());
        await process.manager.rehydratePersistedSessions(process.pool);
        if (peer) {
          await this.checkPeerRowsSurvived(process, peer, peerRowsBefore);
        }
        if (process.dead) {
          return;
        }
        process.listening = true;
        process.manager.startRehydratedOwnerWindows();
        process.monitor.start();
        this.log(`${process.name} listening`);
        for (const client of this.clients) {
          if (client.daemon === index && client.sessionId && client.alive) {
            this.reopen(client);
          }
        }
      },
      process,
    );
  }

  /** Live, non-releasing sessions of `peer` whose rows are active and stamped with its id. */
  private async liveActiveRows(peer: DaemonProcess): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const session of peer.manager.getAllSessions()) {
      if (peer.manager.getReleasingSession(session.sessionId)) {
        continue;
      }
      const row = await this.repository.getSession(session.sessionId);
      if (row?.status === "active" && row.daemon_session_id === peer.daemonSessionId) {
        ids.add(session.sessionId);
      }
    }
    return ids;
  }

  private async checkPeerRowsSurvived(
    process: DaemonProcess,
    peer: DaemonProcess,
    before: ReadonlySet<string>,
  ): Promise<void> {
    if (peer.dead) {
      return;
    }
    for (const sessionId of before) {
      const stillLive =
        peer.manager.getAllSessions().some((s) => s.sessionId === sessionId) &&
        !peer.manager.getReleasingSession(sessionId);
      if (!stillLive) {
        continue;
      }
      const row = await this.repository.getSession(sessionId);
      if (row?.status !== "active" || row.daemon_session_id !== peer.daemonSessionId) {
        this.fail(
          "peer-row-expired",
          `${process.name}'s startup left live peer ${peer.name}'s session ${sessionId} row ` +
            `${row?.status ?? "missing"} (${row?.release_reason ?? "-"}, owner ${row?.daemon_session_id ?? "-"})`,
        );
      }
    }
  }

  async start(): Promise<void> {
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.startProcess(0);
    this.startProcess(1);
    await this.settle();
  }

  async stopAll(): Promise<void> {
    for (const process of this.daemons) {
      if (process && !process.dead) {
        this.markDead(process);
        void process.monitor.stop();
        process.manager.stopCleanupTimer();
      }
    }
    this.timer.resolveAll();
    await drainMicrotasks(SETTLE_TURNS);
  }

  // ---------------------------------------------------------------------------------------------
  // Invariants

  async checkSettled(): Promise<void> {
    await this.checkLiveRowsOwned();
    const holders = new Map<string, string>();
    for (const process of this.daemons) {
      if (!process || process.dead) {
        continue;
      }
      const live = new Set(process.manager.getAllSessions().map((s) => s.sessionId));
      for (const device of process.pool.getAllDevices()) {
        if (!device.sessionId || !live.has(device.sessionId)) {
          continue;
        }
        const other = holders.get(device.id);
        if (other) {
          this.fail(
            "device-two-daemons",
            `${device.id} is assigned in two live daemons: ${other} and ${process.name}:${device.sessionId}`,
          );
        }
        holders.set(device.id, `${process.name}:${device.sessionId}`);
        const claim = this.claims.files.get(this.claims.claimPath(device.id));
        if (process.listening && claim?.pid !== process.pid) {
          this.fail(
            "unclaimed-assignment",
            `${process.name} (pid ${process.pid}) assigns ${device.id} to ${device.sessionId}, but ` +
              `its claim names ${claim ? `pid ${claim.pid}` : "nobody"}`,
          );
        }
      }
    }
  }

  /**
   * At a settle point every live session of a listening daemon has an active row stamped with
   * that daemon's id: nothing else (a peer's sweep, rehydration or rollback) took it over or
   * terminalized it under the daemon.
   */
  private async checkLiveRowsOwned(): Promise<void> {
    for (const process of this.daemons) {
      if (!process || process.dead || !process.listening) {
        continue;
      }
      for (const session of process.manager.getAllSessions()) {
        if (process.manager.getReleasingSession(session.sessionId)) {
          continue;
        }
        const row = await this.repository.getSession(session.sessionId);
        if (row?.status !== "active" || row.daemon_session_id !== process.daemonSessionId) {
          this.fail(
            "live-row-not-owned",
            `${process.name} holds ${session.sessionId} live on ${session.assignedDevice}, but its ` +
              `row is ${row?.status ?? "missing"} (${row?.release_reason ?? "-"}, owner ` +
              `${row?.daemon_session_id ?? "-"})`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Operations

  private liveDaemon(index: number): DaemonProcess | undefined {
    const process = this.daemons[index];
    return process && !process.dead && process.listening ? process : undefined;
  }

  private connectionFor(client: ClientState): string {
    if (!client.connection) {
      client.generation++;
      client.connection = `conn-${client.index}-${client.generation}`;
    }
    return client.connection;
  }

  private async heartbeat(client: ClientState): Promise<void> {
    const process = this.liveDaemon(client.daemon);
    const sessionId = client.sessionId;
    if (!process || !sessionId) {
      return;
    }
    const claim = client.needsClaim;
    let response: Awaited<ReturnType<typeof handleDaemonRequest>>;
    try {
      response = await handleDaemonRequest(
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
        process.state,
      );
    } catch (error) {
      // A claim heartbeat whose liveness-owner row write lost to the session's release reports
      // the session gone (#11200); a throw that the session ended around is still a failed
      // heartbeat to the proxy, not a finding. Only a throw for a live session is a finding.
      if (
        process.manager.hasSession(sessionId) &&
        !process.manager.getReleasingSession(sessionId)
      ) {
        const row = await this.repository.getSession(sessionId);
        if (row?.status === "active" && row.daemon_session_id === process.daemonSessionId) {
          throw error;
        }
        // The owner's claim fails because its live session's row was taken from its daemon.
        this.fail(
          "live-row-not-owned",
          `c${client.index}'s heartbeat on ${process.name} failed (${errorMessage(error)}): live ` +
            `${sessionId}'s row is ${row?.status ?? "missing"} (owner ${row?.daemon_session_id ?? "-"})`,
        );
        return;
      }
      this.log(
        `  c${client.index} heartbeat for released ${sessionId} failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (response.success) {
      client.needsClaim = false;
    } else if (client.sessionId === sessionId && !process.manager.hasSession(sessionId)) {
      this.log(`  c${client.index} heartbeat refused: ${sessionId} gone from ${process.name}`);
      client.sessionId = undefined;
    }
  }

  private adoptSession(client: ClientState, process: DaemonProcess, sessionId: string): void {
    client.daemon = process.index;
    client.sessionId = sessionId;
    client.needsClaim = true;
    client.ownerToken = `owner-${client.index}-${sessionId}`;
  }

  /** getAndroid with a deviceId: an explicit bind through daemon `index`. */
  acquire(client: ClientState, index: number, deviceIndex: number): void {
    const process = this.liveDaemon(index);
    if (!process || client.sessionId) {
      return;
    }
    const device = DEVICES[deviceIndex]!;
    const sessionId = `s${++this.sessionCounter}`;
    const connection = this.connectionFor(client);
    this.log(`c${client.index} acquire ${device.deviceId} via ${process.name} as ${sessionId}`);
    this.launch(
      `c${client.index} acquire ${device.deviceId} via ${process.name}`,
      async () => {
        const bound = await process.pool.bindOrReuseDeviceSession(
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
          false,
        );
        this.log(`  c${client.index} bound ${device.deviceId} -> ${bound} on ${process.name}`);
        if (process.dead) {
          return;
        }
        this.adoptSession(client, process, bound);
        await this.heartbeat(client);
      },
      process,
    );
  }

  /** getAndroid with no deviceId: platform allocation through daemon `index`. */
  acquireAny(client: ClientState, index: number): void {
    const process = this.liveDaemon(index);
    if (!process || client.sessionId) {
      return;
    }
    const sessionId = `s${++this.sessionCounter}`;
    this.log(`c${client.index} acquireAny via ${process.name} as ${sessionId}`);
    this.launch(
      `c${client.index} acquireAny via ${process.name}`,
      async () => {
        const session = await process.manager.getOrCreateSession(
          sessionId,
          process.pool,
          "android",
        );
        this.log(
          `  c${client.index} allocated ${session.assignedDevice} -> ${sessionId} on ${process.name}`,
        );
        if (process.dead) {
          return;
        }
        this.adoptSession(client, process, sessionId);
        await this.heartbeat(client);
      },
      process,
    );
  }

  release(client: ClientState): void {
    const process = this.liveDaemon(client.daemon);
    const sessionId = client.sessionId;
    if (!process || !sessionId) {
      return;
    }
    this.log(`c${client.index} releaseSession ${sessionId} on ${process.name}`);
    this.launch(
      `c${client.index} release ${sessionId}`,
      async () => {
        const response = await handleDaemonRequest(
          {
            id: `rel-${client.index}`,
            type: "daemon_request",
            method: "daemon/releaseSession",
            params: { sessionId },
          },
          process.state,
        );
        if (!response.success && !process.dead) {
          throw new Error(`releaseSession failed: ${JSON.stringify(response)}`);
        }
        if (client.sessionId === sessionId) {
          client.sessionId = undefined;
        }
      },
      process,
    );
  }

  control(client: ClientState): void {
    const process = this.liveDaemon(client.daemon);
    const sessionId = client.sessionId;
    if (!process || !sessionId) {
      return;
    }
    this.log(`c${client.index} control ${sessionId} on ${process.name}`);
    this.launch(
      `c${client.index} control ${sessionId}`,
      async () => {
        await process.manager.getOrCreateSession(sessionId);
        await drainMicrotasks(2);
        process.manager.recordToolCallEnded(sessionId, { admitted: true });
      },
      process,
    );
  }

  async advance(ms: number): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(PROXY_HEARTBEAT_INTERVAL_MS, remaining);
      this.timer.advanceTime(chunk);
      remaining -= chunk;
      for (const client of this.clients) {
        if (client.alive && client.connection && client.sessionId) {
          await this.heartbeat(client);
        }
      }
      await drainMicrotasks(20);
      if (this.violation) {
        return;
      }
    }
  }

  /**
   * killDevice on daemon `index`, called by client `client` (its session, when it has one, is
   * the requester). The tool's lifecycle guard runs against that daemon's state, as it does in
   * production; a refused kill stops there.
   */
  kill(client: ClientState, index: number, deviceIndex: number): void {
    const process = this.liveDaemon(index);
    if (!process) {
      return;
    }
    const device = DEVICES[deviceIndex]!;
    const requester = {
      sessionUuid: client.daemon === index ? client.sessionId : undefined,
      mcpSessionId: client.daemon === index ? client.connection : undefined,
    };
    this.log(`${process.name} killDevice ${device.deviceId} by c${client.index}`);
    this.launch(
      `${process.name} killDevice ${device.deviceId}`,
      async () => {
        const daemonState = DaemonState.getInstance();
        daemonState.initialize(process.manager, process.pool);
        let foreignCheck: Promise<void>;
        try {
          assertLifecycleCallerHoldsDevice({
            toolName: "killDevice",
            device: { deviceId: device.deviceId, platform: "android" },
            requester,
            force: false,
          });
          // Binds this daemon's state before its first await, as the tool handler does.
          foreignCheck = assertLifecycleTargetNotHeldByOtherDaemon({
            toolName: "killDevice",
            device: { deviceId: device.deviceId, platform: "android" },
            force: false,
          });
        } finally {
          daemonState.reset();
        }
        await foreignCheck;
        const reservation = await process.pool.reserveDeviceForShutdown(
          device.deviceId,
          undefined,
          undefined,
          undefined,
          { toolName: "killDevice", force: false },
        );
        if (!reservation || process.dead) {
          return;
        }
        try {
          const peer = this.peerOf(process);
          const peerHolder = peer?.pool.getDevice(device.deviceId)?.sessionId;
          // An assignment whose claim the peer has not published yet is provisional: the claim
          // this kill published wins it, so the peer rolls the assignment back (#11200).
          const peerClaim = this.claims.files.get(this.claims.claimPath(device.deviceId));
          if (
            peer &&
            peerHolder &&
            peer.manager.hasSession(peerHolder) &&
            peerClaim?.pid === peer.pid
          ) {
            this.fail(
              "kill-foreign-device",
              `${process.name} killed ${device.deviceId} (requester ${requester.sessionUuid ?? "none"}) ` +
                `while live peer ${peer.name} holds it for ${peerHolder}`,
            );
          }
          this.online[deviceIndex] = false;
          this.discovery.setBootedDevices("android", this.onlineDevices());
          const session = reservation.session;
          if (session && session.assignedDevice === device.deviceId) {
            await process.manager.releaseSessionIfOwned(
              session.sessionId,
              session,
              device.deviceId,
              "device-killed",
            );
          }
          if (process.pool.getDevice(device.deviceId) === reservation.device) {
            await process.pool.retireDeviceForShutdown(reservation.device);
          }
          if (peer) {
            this.dropDevice(peer, deviceIndex);
          }
        } finally {
          await reservation.release();
        }
      },
      process,
    );
  }

  /** A daemon's disconnect monitor notices a serial left adb: cancel its session, drop it. */
  private dropDevice(process: DaemonProcess, deviceIndex: number): void {
    const device = DEVICES[deviceIndex]!;
    this.launch(
      `${process.name} drop ${device.deviceId}`,
      async () => {
        if (process.dead) {
          return;
        }
        const pooled = process.pool.getDevice(device.deviceId);
        const sessionId = pooled?.sessionId ?? null;
        if (sessionId && process.manager.getSession(sessionId)) {
          await releaseSessionAndDevice(
            process.manager,
            process.pool,
            device.deviceId,
            sessionId,
            deviceLossCancellationReason(device.deviceId),
          );
        }
        await process.pool.removeDisconnectedDevice(
          device.deviceId,
          false,
          undefined,
          pooled ?? undefined,
        );
      },
      process,
    );
  }

  disconnect(deviceIndex: number): void {
    if (!this.online[deviceIndex]) {
      return;
    }
    this.online[deviceIndex] = false;
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.log(`disconnect ${DEVICES[deviceIndex]!.deviceId}`);
    for (const process of this.daemons) {
      if (process && !process.dead && process.listening) {
        this.dropDevice(process, deviceIndex);
      }
    }
  }

  reconnect(deviceIndex: number): void {
    if (this.online[deviceIndex]) {
      return;
    }
    this.online[deviceIndex] = true;
    this.discovery.setBootedDevices("android", this.onlineDevices());
    this.log(`reconnect ${DEVICES[deviceIndex]!.deviceId}`);
    for (const process of this.daemons) {
      if (process && !process.dead && process.listening) {
        this.launch(
          `${process.name} refresh`,
          async () => {
            await process.pool.refreshDevices();
          },
          process,
        );
      }
    }
  }

  wedge(index: number): void {
    const process = this.daemons[index];
    if (process && !process.dead) {
      this.log(`${process.name} DB writer wedged`);
      process.wedged = true;
    }
  }

  unwedge(index: number): void {
    const process = this.daemons[index];
    if (process && !process.dead && process.wedged) {
      this.log(`${process.name} DB writer unwedged (${process.parked.length} parked)`);
      process.wedged = false;
      for (const flush of process.parked.splice(0)) {
        flush();
      }
    }
  }

  /** kill -9: everything the process would still do stops; its rows, claims and journal stay. */
  crash(index: number): void {
    const process = this.daemons[index];
    if (!process || process.dead) {
      return;
    }
    this.log(`${process.name} crashes`);
    // kill -9 waits for nothing: a monitor tick parked on a wedged write never finishes.
    this.markDead(process);
    void process.monitor.stop();
    process.manager.stopCleanupTimer();
    this.disconnectClients(index);
  }

  /** The process exits: its unfinished operations never finish, and nothing waits for them. */
  private markDead(process: DaemonProcess): void {
    process.dead = true;
    process.parked.length = 0;
    for (const [run, owner] of this.inflight) {
      if (owner === process) {
        this.inflight.delete(run);
      }
    }
  }

  /** Graceful stop: release every session as daemon-shutdown (recoverable), withdraw claims. */
  stop(index: number): void {
    const process = this.liveDaemon(index);
    if (!process) {
      return;
    }
    this.log(`${process.name} stopping`);
    process.listening = false;
    this.launch(
      `${process.name} stop`,
      async () => {
        await process.monitor.stop();
        const sessionIds = process.manager.getAllKnownSessionIds();
        await Promise.allSettled(
          sessionIds.map(async (sessionId) => {
            const deviceId =
              process.pool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ??
              null;
            await releaseSessionAndDevice(
              process.manager,
              process.pool,
              deviceId,
              sessionId,
              "daemon-shutdown",
            );
          }),
        );
        process.pool.releaseDeviceClaimsForShutdown();
        process.manager.stopCleanupTimer();
        this.log(`${process.name} stopped`);
        this.markDead(process);
      },
      process,
    );
    this.disconnectClients(index);
  }

  private disconnectClients(index: number): void {
    for (const client of this.clients) {
      if (client.daemon === index && client.connection) {
        client.connection = undefined;
        client.needsClaim = true;
      }
    }
  }

  startDaemon(index: number): void {
    const process = this.daemons[index];
    if (process && !process.dead) {
      return;
    }
    this.startProcess(index);
  }

  /** The owner's proxy reconnects to its daemon and restores the session it holds. */
  private reopen(client: ClientState): void {
    const process = this.liveDaemon(client.daemon);
    const sessionId = client.sessionId;
    if (!process || !sessionId) {
      return;
    }
    const connection = this.connectionFor(client);
    client.needsClaim = true;
    this.log(`c${client.index} reopen ${connection} on ${process.name} restoring ${sessionId}`);
    this.launch(
      `c${client.index} reopen`,
      async () => {
        await process.pool.restoreOwnedDeviceSessionsForMcpSession([sessionId], connection);
        await this.heartbeat(client);
      },
      process,
    );
  }

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

  async apply(step: TwoDaemonStep): Promise<void> {
    const client = this.clients[step.client]!;
    switch (step.kind) {
      case "acquire":
        this.acquire(client, step.daemon, step.device);
        break;
      case "acquireAny":
        this.acquireAny(client, step.daemon);
        break;
      case "release":
        this.release(client);
        break;
      case "control":
        this.control(client);
        break;
      case "loseHeartbeat":
        this.log(`c${client.index} stops heartbeating`);
        client.alive = false;
        break;
      case "resumeHeartbeat":
        this.log(`c${client.index} resumes heartbeating`);
        client.alive = true;
        if (!client.connection) {
          this.reopen(client);
        }
        break;
      case "advance":
        this.log(`advance ${step.ms}ms`);
        await this.advance(step.ms);
        break;
      case "monitorTick": {
        const process = this.liveDaemon(step.daemon);
        if (process) {
          this.log(`${process.name} monitor tick`);
          this.launch(`${process.name} monitor tick`, () => process.monitor.tick(), process);
        }
        break;
      }
      case "cleanupSweep": {
        const process = this.liveDaemon(step.daemon);
        if (process) {
          this.log(`${process.name} cleanup sweep`);
          process.manager.cleanupExpiredSessions();
        }
        break;
      }
      case "kill":
        this.kill(client, step.daemon, step.device);
        break;
      case "disconnect":
        this.disconnect(step.device);
        break;
      case "reconnect":
        this.reconnect(step.device);
        break;
      case "wedge":
        this.wedge(step.daemon);
        break;
      case "unwedge":
        this.unwedge(step.daemon);
        break;
      case "crash":
        this.crash(step.daemon);
        break;
      case "stop":
        this.stop(step.daemon);
        break;
      case "start":
        this.startDaemon(step.daemon);
        break;
      case "settle":
        for (const index of [0, 1]) {
          this.unwedge(index);
        }
        await this.settle();
        await this.checkSettled();
        break;
    }
    await drainMicrotasks(step.turns);
  }
}

/** Replay `steps` against a fresh two-daemon world; stops at the first invariant violation. */
export async function runTwoDaemonSteps(
  steps: readonly TwoDaemonStep[],
  options: TwoDaemonRunOptions = {},
): Promise<TwoDaemonRunResult> {
  const db = await createTestDatabase();
  const world = new TwoDaemonWorld(db, options.tolerate ?? new Set());
  try {
    await world.start();
    for (const [index, step] of steps.entries()) {
      world.stepIndex = index;
      world.log(describeTwoDaemonStep(step, index));
      await world.apply(step);
      if (world.violation) {
        break;
      }
    }
    if (!world.violation) {
      world.stepIndex = steps.length;
      for (const index of [0, 1]) {
        world.unwedge(index);
      }
      await world.settle();
      await world.checkSettled();
    }
    return { violation: world.violation, trace: world.trace };
  } finally {
    await world.stopAll();
    await db.destroy();
  }
}

export async function shrinkTwoDaemonSteps(
  steps: readonly TwoDaemonStep[],
  options: TwoDaemonRunOptions = {},
): Promise<TwoDaemonStep[]> {
  const first = await runTwoDaemonSteps(steps, options);
  if (!first.violation) {
    return [...steps];
  }
  let current = steps.slice(0, first.violation.step + 1);
  let changed = true;
  for (let pass = 0; pass < 4 && changed; pass++) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      const result = await runTwoDaemonSteps(candidate, options);
      if (result.violation?.kind === first.violation.kind) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

function nonNegativeIntEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A local seed sweep, when AUTOMOBILE_TWO_DAEMON_SEEDS (how many) and/or
 * AUTOMOBILE_TWO_DAEMON_SEED_BASE (first seed) are set; undefined to use the checked-in seeds.
 */
export function twoDaemonSeedOverride(): number[] | undefined {
  const count = nonNegativeIntEnv("AUTOMOBILE_TWO_DAEMON_SEEDS");
  const base = nonNegativeIntEnv("AUTOMOBILE_TWO_DAEMON_SEED_BASE");
  if (!count && base === undefined) {
    return undefined;
  }
  return Array.from({ length: count || 1 }, (_, i) => (base ?? 1) + i);
}

export async function assertTwoDaemonInvariants(
  seeds: readonly number[],
  profile: TwoDaemonProfile,
  options: TwoDaemonRunOptions = {},
): Promise<void> {
  for (const seed of seeds) {
    const steps = generateTwoDaemonSteps(seed, profile);
    const result = await runTwoDaemonSteps(steps, options);
    if (result.violation) {
      const shrunk = await shrinkTwoDaemonSteps(steps, options);
      const replay = await runTwoDaemonSteps(shrunk, options);
      throw new Error(
        `Two-daemon invariant [${result.violation.kind}] violated for seed ${seed}: ` +
          `${result.violation.message}\n` +
          `Replay: AUTOMOBILE_TWO_DAEMON_SEED_BASE=${seed} AUTOMOBILE_TWO_DAEMON_SEEDS=1\n` +
          `Shrunk to ${shrunk.length} steps (${replay.violation?.message ?? "no longer fails"}):\n` +
          `${shrunk.map(describeTwoDaemonStep).join("\n")}\nTrace:\n${replay.trace.join("\n")}`,
      );
    }
  }
}
