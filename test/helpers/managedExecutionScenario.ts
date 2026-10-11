import { spyOn } from "bun:test";
import type { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  RegistryManagedSlotExclusion,
  type ManagedSlotExclusion,
} from "../../src/daemon/managedSlots/managedSlotExclusion";
import * as acquisitionModule from "../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import type { ManagedSlotToolInvoker } from "../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import * as ownerLivenessModule from "../../src/daemon/managedSlots/slotOwnerLiveness";
import type {
  SlotAssignmentRecord,
  SlotExecOwnerLiveness,
  SlotKey,
  SlotRegistry,
} from "../../src/daemon/managedSlots/slotRegistry";
import * as sqliteRegistryModule from "../../src/daemon/managedSlots/sqliteSlotRegistry";
import { parseManagedSlotConfig } from "../../src/models/managedSlotConfig";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";
import { executionTracker } from "../../src/server/executionTracker";
import { drainMicrotasks } from "./fakeTimerStepping";
import type { LivenessScenarioOptions } from "./livenessScenarioHarness";
import { RestartScenario } from "./daemonRestartScenario";

// A managed slot execution on a real daemon, end to end (from the restart hunt behind #11642).
//
// Built on RestartScenario (a real `Daemon` over a real session repository, the real control
// socket and real `DaemonMcpProxy` instances, one FakeTimer). The Daemon's own managed-slot wiring
// runs unchanged: `installManagedExecutionRelease`, `installManagedSlotAcquisition`, the re-owner,
// the scope reset and the release listener. Only its four host seams are replaced, at the module
// functions the Daemon calls:
// - `openSqliteSlotRegistry`: one real SQLite registry in memory, shared by every daemon
//   "process" like the host-wide file is, judging owners with the predicate of whichever daemon
//   opened it last (each process opens the file with its own);
// - `currentSlotOwnerProcess`: each daemon "process" has its own PID, so a successor reads the
//   first daemon's records as another, dead process (in one test process both would otherwise
//   carry `process.pid` and read as "a record this daemon wrote");
// - `withLiveExecutionSessions`: the process-liveness probe answers from the scenario's set of
//   live PIDs instead of probing the host;
// - `createDaemonManagedSlotAcquisition`: the reconciler's device tooling (image listing, AVD
//   config, image catalog, boot gate) and `provisionDevice` are the device boundary: provisioning
//   binds a fresh session to the slot's running device through the daemon's real pool.
// The pool's managed-slot exclusion is the real `RegistryManagedSlotExclusion` over that registry
// (the liveness harness plugs in one that holds nothing), one instance per daemon process, and an
// execution's tool calls go through its own real `DaemonMcpProxy`.

const RUNTIME = "system-images;android-36;google_apis;x86_64";
const MODEL = "pixel_9";
const FIRST_DAEMON_PID = 41_001;

export interface SlotSnapshot {
  state: string;
  generation: number;
  device: string | null;
  owner: { pid: number; sessionUuid: string } | null;
  settlerPid: number | null;
  openJournal: string[];
}

export interface ScopeIdentity {
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
}

export const SCOPE: ScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-A",
  runnerIncarnation: "boot-1",
};

export interface ManagedExecution {
  proxy: DaemonMcpProxy;
  connection: string;
  result: ManagedSlotsResult;
  sessionUuid: string | null;
}

/**
 * Let real I/O land: a few event-loop turns. The scenario clock only drains microtasks, and the
 * acquisition-time setting reset reads its record through real async I/O; until it lands the
 * device reads as "cleanup in progress" to the next acquirer.
 */
async function settleIo(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await drainMicrotasks(64);
  }
}

export class ManagedExecutionScenario {
  /** PIDs of daemon "processes" that are running. */
  readonly livePids = new Set<number>();
  /** Every `provisionDevice` the reconciler ran: the device name and the session it minted. */
  readonly provisioned: Array<{ name: string; sessionUuid: string; daemonPid: number }> = [];
  private readonly spies: Array<ReturnType<typeof spyOn>> = [];
  private exclusion!: ManagedSlotExclusion;
  private restoreExclusion: (() => void) | undefined;
  private restoreTrackerTimer: (() => void) | undefined;
  private shared: SlotRegistry | undefined;
  private liveness: SlotExecOwnerLiveness = () => false;
  private readonly pid = FIRST_DAEMON_PID;
  private minted = 0;
  private static instances = 0;
  /** Session ids are unique per scenario: the execution tracker is process-wide. */
  private readonly instance = ++ManagedExecutionScenario.instances;
  private tokens = 0;
  restart!: RestartScenario;

  static async start(options: LivenessScenarioOptions = {}): Promise<ManagedExecutionScenario> {
    const scenario = new ManagedExecutionScenario();
    scenario.installSeams();
    scenario.livePids.add(scenario.pid);
    try {
      scenario.restart = await RestartScenario.start(options);
    } catch (error) {
      // The file shares its test process: never leave the module seams behind a failed start.
      scenario.restoreSeams();
      throw error;
    }
    scenario.installExclusion();
    // The process-wide execution tracker bounds the drain's wait for in-flight work on its own
    // clock: put it on the scenario clock, so the 500 ms drain budget passes when the scenario's does.
    const trackerTimer: unknown = Reflect.get(executionTracker, "timer");
    Reflect.set(executionTracker, "timer", scenario.restart.timer);
    scenario.restoreTrackerTimer = () => Reflect.set(executionTracker, "timer", trackerTimer);
    return scenario;
  }

  get daemonPid(): number {
    return this.pid;
  }

  get scenario() {
    return this.restart.scenario;
  }

  avdOf(deviceId: string): string {
    return `Pixel_${deviceId}`;
  }

  private installSeams(): void {
    const openRegistry = sqliteRegistryModule.openSqliteSlotRegistry;
    const withSessions = ownerLivenessModule.withLiveExecutionSessions;
    const createAcquisition = acquisitionModule.createDaemonManagedSlotAcquisition;
    this.spies.push(
      spyOn(sqliteRegistryModule, "slotRegistryFileExists").mockImplementation(
        () => this.shared !== undefined,
      ),
      spyOn(sqliteRegistryModule, "openSqliteSlotRegistry").mockImplementation((async (
        options: { isExecOwnerLive?: SlotExecOwnerLiveness } = {},
      ) => {
        // Each process opens the host-wide file with its own owner-liveness predicate.
        if (options.isExecOwnerLive) {
          this.liveness = options.isExecOwnerLive;
        }
        return await this.processView();
      }) as never),
      spyOn(ownerLivenessModule, "currentSlotOwnerProcess").mockImplementation(() => ({
        pid: this.pid,
        processGenerationToken: `generation-of-${this.pid}`,
      })),
      spyOn(ownerLivenessModule, "withLiveExecutionSessions").mockImplementation(
        (_processLiveness, sessions, options) =>
          withSessions((owner) => this.livePids.has(owner.pid), sessions, {
            thisProcess: { pid: this.pid },
            ...options,
          }),
      ),
      spyOn(acquisitionModule, "createDaemonManagedSlotAcquisition").mockImplementation((options) =>
        createAcquisition({
          ...options,
          invokeTool: this.provisionDevice(this.pid),
          tooling: {
            deviceManager: {
              listDeviceImages: async (platform) =>
                platform === "android"
                  ? this.scenario.deviceIds.map((deviceId) => ({
                      name: this.avdOf(deviceId),
                      platform: "android" as const,
                      isRunning: true,
                    }))
                  : [],
            },
            androidConfigReader: {
              readConfig: async () => ({
                systemImagePackage: RUNTIME,
                apiLevel: 36,
                tag: "google_apis",
                architecture: "x86_64",
                deviceName: MODEL,
              }),
            },
            androidImageCatalog: { listInstalledPackages: async () => [RUNTIME] },
            checkBootCapacity: async () => {},
          },
        }),
      ),
    );
    this.openShared = async () =>
      await openRegistry({
        dbPath: ":memory:",
        timer: this.restart.timer,
        isExecOwnerLive: (owner) => this.liveness(owner),
      });
  }

  private openShared!: () => Promise<SlotRegistry>;

  private newExclusion(): ManagedSlotExclusion {
    return new RegistryManagedSlotExclusion(
      () => this.processView(),
      this.restart.timer,
      () => this.shared !== undefined,
    );
  }

  /**
   * The liveness harness hands every pool one exclusion object that holds nothing. Make that
   * object the real registry-backed exclusion of the running daemon process.
   */
  private installExclusion(): void {
    this.exclusion = this.newExclusion();
    const plugged = Reflect.get(this.scenario.daemon.pool, "managedSlotExclusion") as Record<
      keyof ManagedSlotExclusion,
      unknown
    >;
    const original = { ...plugged };
    plugged.refresh = (options?: Parameters<ManagedSlotExclusion["refresh"]>[0]) =>
      this.exclusion.refresh(options);
    plugged.holderOf = (device: Parameters<ManagedSlotExclusion["holderOf"]>[0]) =>
      this.exclusion.holderOf(device);
    plugged.stableIdsFor = (platform: Parameters<ManagedSlotExclusion["stableIdsFor"]>[0]) =>
      this.exclusion.stableIdsFor(platform);
    this.restoreExclusion = () => Object.assign(plugged, original);
  }

  /** The one registry "file"; a process that closes its handle does not close the file. */
  async registry(): Promise<SlotRegistry> {
    this.shared ??= await this.openShared();
    return this.shared;
  }

  private async processView(): Promise<SlotRegistry> {
    const shared = await this.registry();
    const view = Object.create(shared) as SlotRegistry;
    view.close = async () => {};
    return view;
  }

  /**
   * `provisionDevice` as the reconciler invokes it: a fresh session on the named, running device,
   * bound through the daemon's real pool, in the tool's success shape.
   */
  private provisionDevice(daemonPid: number): ManagedSlotToolInvoker {
    return async (_name, args) => {
      const device = Reflect.get(args, "device") as { name: string };
      const deviceId = this.scenario.deviceIds.find((id) => this.avdOf(id) === device.name);
      if (!deviceId) {
        return {
          isError: true,
          structuredContent: {
            error: {
              code: "platform_command_failed",
              message: `scenario: ${device.name} is not a running scenario device`,
              retryable: true,
            },
          },
        };
      }
      const sessionUuid = `managed-session-${this.instance}-${++this.minted}`;
      const { manager, pool } = this.scenario.daemon;
      await pool.bindOrReuseDeviceSession(sessionUuid, deviceId, "android");
      manager.setDeviceReadiness(sessionUuid, "automationReady");
      this.provisioned.push({ name: device.name, sessionUuid, daemonPid });
      return {
        structuredContent: {
          created: false,
          sessionId: sessionUuid,
          device: {
            name: device.name,
            identity: { stableId: device.name },
            runtime: { deviceId },
          },
          readiness: { mode: "automation", status: "automation_ready" },
        },
      };
    };
  }

  /** The slot holds `deviceId` from an earlier execution: ready, idle, no execution owner. */
  async assignSlot(
    deviceId: string,
    scope: ScopeIdentity = SCOPE,
    slotIndex = 0,
  ): Promise<SlotKey> {
    const registry = await this.registry();
    const ensured = await registry.ensureScope(scope);
    if (ensured.kind !== "ready") {
      throw new Error(`scope not ready: ${ensured.kind}`);
    }
    const key = { scopeKey: ensured.scope.scopeKey, slotIndex };
    const spec = { runtime: RUNTIME, deviceType: MODEL };
    await registry.initSlot(key, { role: "app", platform: "android", requestedSpec: spec });
    const committed = await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: this.avdOf(deviceId),
        deviceName: this.avdOf(deviceId),
        resolvedSpec: { ...spec, displayCutout: "unknown" },
        specFingerprint: "v1:own",
        state: "ready",
      },
    );
    if (committed.kind !== "committed") {
      throw new Error(`binding not committed: ${committed.kind}`);
    }
    return key;
  }

  /**
   * A runner launches an execution proxy for the slot: a real `DaemonMcpProxy` on its own
   * connection runs the real acquisition (`acquireManagedSlots`), with the clock running while it
   * waits.
   */
  async launchExecution(
    scope: ScopeIdentity = SCOPE,
    slotIndex = 0,
    idleTimeoutMs?: number,
  ): Promise<ManagedExecution> {
    const token = `managed-proxy-${++this.tokens}`;
    const proxy = this.scenario.addProxy({ token });
    const config = this.configFor(scope, slotIndex, idleTimeoutMs);
    let result: ManagedSlotsResult | undefined;
    let failure: unknown;
    void proxy.acquireManagedSlots(config).then(
      (acquired) => {
        result = acquired;
      },
      (error: unknown) => {
        failure = error;
      },
    );
    for (let step = 0; step < 600 && result === undefined && failure === undefined; step++) {
      await settleIo();
      if (result === undefined && failure === undefined) {
        await this.scenario.idle(50);
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    if (!result) {
      throw new Error("ManagedExecutionScenario: the acquisition did not answer in 30 s");
    }
    await settleIo();
    const execution: ManagedExecution = {
      proxy,
      connection: `scenario-connection:${token}`,
      result,
      sessionUuid: result.slots[0]?.sessionUuid ?? null,
    };
    return execution;
  }

  private configFor(scope: ScopeIdentity, slotIndex: number, idleTimeoutMs?: number) {
    return parseManagedSlotConfig({
      contractVersion: 1,
      ...scope,
      localSlotCapacity: 1,
      preparationTimeoutMs: 20_000,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      requests: [
        {
          slotIndex,
          role: "app",
          platform: "android",
          requestedSpec: { runtime: RUNTIME, deviceType: MODEL },
        },
      ],
    });
  }

  /** Await `work` with the scenario clock running (it may wait on timers), up to `budgetMs`. */
  async during<T>(work: Promise<T>, budgetMs = 20_000, stepMs = 100): Promise<T> {
    let settled = false;
    const tracked = work.finally(() => {
      settled = true;
    });
    tracked.catch(() => undefined);
    for (let waited = 0; waited < budgetMs && !settled; waited += stepMs) {
      await settleIo();
      if (!settled) {
        await this.scenario.idle(stepMs);
      }
    }
    if (!settled) {
      throw new Error(`ManagedExecutionScenario: work did not settle in ${budgetMs} ms`);
    }
    return await tracked;
  }

  /** Advance the scenario clock, then let real I/O land. */
  async idle(ms: number): Promise<void> {
    await this.restart.idle(ms);
    await settleIo();
  }

  async slot(key: SlotKey): Promise<SlotSnapshot | null> {
    const registry = await this.registry();
    const assignment: SlotAssignmentRecord | null = await registry.getAssignment(key);
    if (!assignment) {
      return null;
    }
    const journal = await registry.listOpenSlotJournal(key);
    return {
      state: assignment.state,
      generation: assignment.generation,
      device: assignment.stableDeviceId,
      owner: assignment.execOwner
        ? { pid: assignment.execOwner.pid, sessionUuid: assignment.execOwner.sessionUuid }
        : null,
      settlerPid: assignment.settler?.pid ?? null,
      openJournal: journal.map((entry) => `${entry.kind}:${entry.phase}`),
    };
  }

  async stop(): Promise<void> {
    // Open calls and proxies may wait on timers: end them with the clock running.
    try {
      const gates = Reflect.get(this.scenario, "gates") as Map<string, unknown>;
      gates.clear();
      await this.during(this.restart.stop(), 60_000, 500).catch(() => undefined);
      this.restoreExclusion?.();
      await this.shared?.close();
    } finally {
      this.restoreTrackerTimer?.();
      this.restoreSeams();
    }
  }

  private restoreSeams(): void {
    for (const spy of this.spies.splice(0)) {
      spy.mockRestore();
    }
  }
}
