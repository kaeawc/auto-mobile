import { spyOn } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonMcpProxy } from "../../../../src/daemon/daemonMcpProxy";
import {
  RegistryBindingExclusion,
  type BindingExclusion,
} from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import * as acquisitionModule from "../../../../src/daemon/sessionBroker/provisioning/daemonDeviceAcquisition";
import type { BindingToolInvoker } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import * as ownerLivenessModule from "../../../../src/daemon/sessionBroker/registry/ownerLiveness";
import type {
  BindingAssignmentRecord,
  BindingExecOwnerLiveness,
  BindingKey,
  BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import * as sqliteRegistryModule from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { parseBindingConfig } from "../../../helpers/provisionRequestFixture";
import type { BindingsResult } from "../../../../src/daemon/sessionBroker/provisioning/acquisitionResult";
import { executionTracker } from "../../../../src/server/executionTracker";
import { createProxyMcpServer } from "../../../../src/server/proxyServer";
import { drainMicrotasks } from "../../../helpers/fakeTimerStepping";
import type { LivenessScenarioOptions } from "../../../helpers/livenessScenarioHarness";
import { RestartScenario, type ShutdownKind } from "../../../helpers/restartEndToEndScenario";

// A binding execution across a daemon restart, end to end (#11642).
//
// Built on RestartScenario (a real `Daemon` over a real session repository, the real control
// socket and real `DaemonMcpProxy` instances, one FakeTimer). The Daemon's own binding wiring
// runs unchanged: `installBrokerExecutionRelease`, `installBindingAcquisition`, the re-owner,
// the scope reset and the release listener. Only its four host seams are replaced, at the module
// functions the Daemon calls:
// - `openSqliteBindingRegistry`: one real SQLite registry in memory, shared by every daemon
//   "process" like the host-wide file is, judging owners with the predicate of whichever daemon
//   opened it last (each process opens the file with its own);
// - `currentBindingOwnerProcess`: each daemon "process" has its own PID, so a successor reads the
//   first daemon's records as another, dead process (in one test process both would otherwise
//   carry `process.pid` and read as "a record this daemon wrote");
// - `withLiveExecutionSessions`: the process-liveness probe answers from the scenario's set of
//   live PIDs instead of probing the host;
// - `createDaemonBindingAcquisition`: the reconciler's device tooling (image listing, AVD
//   config, image catalog, boot gate) and `provisionDevice` are the device boundary: provisioning
//   binds a fresh session to the binding's running device through the daemon's real pool.
// The pool's binding exclusion is the real `RegistryBindingExclusion` over that registry
// (the liveness harness plugs in one that holds nothing), one instance per daemon process, and an
// execution's tool calls are answered by the real proxy MCP server (`createProxyMcpServer`), so a
// refusal is read in the shape the runner's MCP client receives.

const RUNTIME = "system-images;android-36;google_apis;x86_64";
const MODEL = "pixel_9";
const FIRST_DAEMON_PID = 41_001;

export interface BindingSnapshot {
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

type ToolCallHandler = (
  request: { method: "tools/call"; params: { name: string; arguments: Record<string, unknown> } },
  extra: unknown,
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;

export interface ManagedExecution {
  proxy: DaemonMcpProxy;
  connection: string;
  result: BindingsResult;
  sessionUuid: string | null;
  /** The proxy MCP server's `tools/call` handler: what the runner's MCP client is answered. */
  callTool: ToolCallHandler;
  closeServer(): Promise<void>;
}

/** A tool call's answer as the MCP client reads it. */
export interface ToolAnswer {
  ok: boolean;
  /** `error.code` of a typed refusal, when the answer carries one. */
  code?: string;
  nextAction?: string;
  text: string;
}

const HANDLER_EXTRA = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error("ManagedRestartScenario: unexpected server-to-client request");
  },
};

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

export class ManagedRestartScenario {
  /** PIDs of daemon "processes" that are running. */
  readonly livePids = new Set<number>();
  /** Every `provisionDevice` the reconciler ran: the device name and the session it minted. */
  readonly provisioned: Array<{ name: string; sessionUuid: string; daemonPid: number }> = [];
  /** AVD names whose emulator is not running (the device is gone). */
  readonly stopped = new Set<string>();
  /** Runs inside `provisionDevice` before it binds a session; may never resolve (a boot in flight). */
  beforeProvision: ((name: string) => Promise<void>) | undefined;
  /** Runs inside `provisionDevice` after the session is bound, before the tool answers. */
  afterProvisionBind: ((sessionUuid: string) => Promise<void>) | undefined;
  private readonly spies: Array<ReturnType<typeof spyOn>> = [];
  private readonly executions: ManagedExecution[] = [];
  private readonly openCallGates: Array<() => void> = [];
  private exclusion!: BindingExclusion;
  private restoreExclusion: (() => void) | undefined;
  private restoreTrackerTimer: (() => void) | undefined;
  private shared: BindingRegistry | undefined;
  private liveness: BindingExecOwnerLiveness = () => false;
  private pid = FIRST_DAEMON_PID;
  private minted = 0;
  private static instances = 0;
  /** Session ids are unique per scenario: the execution tracker is process-wide. */
  private readonly instance = ++ManagedRestartScenario.instances;
  private tokens = 0;
  restart!: RestartScenario;

  static async start(options: LivenessScenarioOptions = {}): Promise<ManagedRestartScenario> {
    const scenario = new ManagedRestartScenario();
    scenario.installSeams();
    scenario.livePids.add(scenario.pid);
    scenario.restart = await RestartScenario.start(options);
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
    const openRegistry = sqliteRegistryModule.openSqliteBindingRegistry;
    const withSessions = ownerLivenessModule.withLiveExecutionSessions;
    const createAcquisition = acquisitionModule.createDaemonBrokerDeviceAcquisition;
    this.spies.push(
      spyOn(sqliteRegistryModule, "bindingRegistryFileExists").mockImplementation(
        () => this.shared !== undefined,
      ),
      spyOn(sqliteRegistryModule, "openSqliteBindingRegistry").mockImplementation((async (
        options: { isExecOwnerLive?: BindingExecOwnerLiveness } = {},
      ) => {
        // Each process opens the host-wide file with its own owner-liveness predicate.
        if (options.isExecOwnerLive) {
          this.liveness = options.isExecOwnerLive;
        }
        return await this.processView();
      }) as never),
      spyOn(ownerLivenessModule, "currentBindingOwnerProcess").mockImplementation(() => ({
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
      spyOn(acquisitionModule, "createDaemonBrokerDeviceAcquisition").mockImplementation(
        (options) =>
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
                        isRunning: !this.stopped.has(this.avdOf(deviceId)),
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

  private openShared!: () => Promise<BindingRegistry>;

  private newExclusion(): BindingExclusion {
    return new RegistryBindingExclusion(
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
    const plugged = Reflect.get(this.scenario.daemon.pool, "bindingExclusion") as Record<
      keyof BindingExclusion,
      unknown
    >;
    const original = { ...plugged };
    plugged.refresh = (options?: Parameters<BindingExclusion["refresh"]>[0]) =>
      this.exclusion.refresh(options);
    plugged.holderOf = (device: Parameters<BindingExclusion["holderOf"]>[0]) =>
      this.exclusion.holderOf(device);
    plugged.stableIdsFor = (platform: Parameters<BindingExclusion["stableIdsFor"]>[0]) =>
      this.exclusion.stableIdsFor(platform);
    this.restoreExclusion = () => Object.assign(plugged, original);
  }

  /** The device's emulator is gone (or back): discovery and the image listing both say so. */
  setRunning(deviceId: string, running: boolean): void {
    if (running) {
      this.stopped.delete(this.avdOf(deviceId));
    } else {
      this.stopped.add(this.avdOf(deviceId));
    }
    const discovery = Reflect.get(this.scenario, "discovery") as {
      setBootedDevices(platform: string, devices: unknown[]): void;
    };
    discovery.setBootedDevices(
      "android",
      this.scenario.deviceIds
        .filter((id) => !this.stopped.has(this.avdOf(id)))
        .map((id) => ({ deviceId: id, name: this.avdOf(id), platform: "android" })),
    );
  }

  /** The one registry "file"; a process that closes its handle does not close the file. */
  async registry(): Promise<BindingRegistry> {
    this.shared ??= await this.openShared();
    return this.shared;
  }

  private async processView(): Promise<BindingRegistry> {
    const shared = await this.registry();
    const view = Object.create(shared) as BindingRegistry;
    view.close = async () => {};
    return view;
  }

  /**
   * `provisionDevice` as the reconciler invokes it: a fresh session on the named, running device,
   * bound through the daemon's real pool, in the tool's success shape.
   */
  private provisionDevice(daemonPid: number): BindingToolInvoker {
    return async (_name, args) => {
      const device = Reflect.get(args, "device") as { name: string };
      const deviceId = this.scenario.deviceIds.find((id) => this.avdOf(id) === device.name);
      if (!deviceId || this.stopped.has(device.name)) {
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
      await this.beforeProvision?.(device.name);
      const sessionUuid = `managed-session-${this.instance}-${++this.minted}`;
      const { manager, pool } = this.scenario.daemon;
      await pool.bindOrReuseDeviceSession(sessionUuid, deviceId, "android");
      manager.setDeviceReadiness(sessionUuid, "automationReady");
      this.provisioned.push({ name: device.name, sessionUuid, daemonPid });
      await this.afterProvisionBind?.(sessionUuid);
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

  /** The binding holds `deviceId` from an earlier execution: ready, idle, no execution owner. */
  async assignBinding(
    deviceId: string,
    scope: ScopeIdentity = SCOPE,
    bindingIndex = 0,
  ): Promise<BindingKey> {
    const registry = await this.registry();
    const ensured = await registry.ensureScope(scope);
    if (ensured.kind !== "ready") {
      throw new Error(`scope not ready: ${ensured.kind}`);
    }
    const key = { scopeKey: ensured.scope.scopeKey, bindingIndex };
    const spec = { runtime: RUNTIME, deviceType: MODEL };
    await registry.initBinding(key, { role: "app", platform: "android", requestedSpec: spec });
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
   * A runner launches an execution proxy for the binding: a real `DaemonMcpProxy` on its own
   * connection runs the real acquisition (`acquireManagedBindings`), with the clock running while it
   * waits.
   */
  async launchExecution(
    scope: ScopeIdentity = SCOPE,
    bindingIndex = 0,
    idleTimeoutMs?: number,
  ): Promise<ManagedExecution> {
    const token = `managed-proxy-${++this.tokens}`;
    const proxy = this.scenario.addProxy({ token });
    const config = this.configFor(scope, bindingIndex, idleTimeoutMs);
    let result: BindingsResult | undefined;
    let failure: unknown;
    void proxy.acquireBindings(config).then(
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
      throw new Error("ManagedRestartScenario: the acquisition did not answer in 30 s");
    }
    await settleIo();
    const registration = spyOn(Server.prototype, "setRequestHandler");
    const { server } = createProxyMcpServer({ proxy, bindings: result });
    const callTool = registration.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as ToolCallHandler | undefined;
    registration.mockRestore();
    if (!callTool) {
      throw new Error("ManagedRestartScenario: the proxy server registered no tools/call handler");
    }
    const execution: ManagedExecution = {
      proxy,
      connection: `scenario-connection:${token}`,
      result,
      sessionUuid: result.bindings[0]?.sessionUuid ?? null,
      callTool,
      closeServer: () => server.close(),
    };
    this.executions.push(execution);
    return execution;
  }

  /** Start an acquisition without waiting for its answer (it may stay in flight). */
  beginExecution(scope: ScopeIdentity = SCOPE, bindingIndex = 0) {
    const token = `managed-proxy-${++this.tokens}`;
    const proxy = this.scenario.addProxy({ token });
    const state: { result?: BindingsResult; failure?: unknown } = {};
    void proxy.acquireBindings(this.configFor(scope, bindingIndex)).then(
      (acquired) => {
        state.result = acquired;
      },
      (error: unknown) => {
        state.failure = error;
      },
    );
    return { proxy, connection: `scenario-connection:${token}`, state };
  }

  private configFor(scope: ScopeIdentity, bindingIndex: number, idleTimeoutMs?: number) {
    return parseBindingConfig({
      contractVersion: 1,
      ...scope,
      localBindingCapacity: 1,
      preparationTimeoutMs: 20_000,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      requests: [
        {
          bindingIndex,
          role: "app",
          platform: "android",
          requestedSpec: { runtime: RUNTIME, deviceType: MODEL },
        },
      ],
    });
  }

  /**
   * One tool call of the execution as its MCP client is answered (the proxy MCP server's
   * `tools/call` handler over the execution's own proxy), with the clock running while it waits.
   */
  async call(
    execution: ManagedExecution,
    tool = "tapOn",
    sessionUuid: string | null = execution.sessionUuid,
  ): Promise<ToolAnswer> {
    let answer: ToolAnswer | undefined;
    void execution
      .callTool(
        { method: "tools/call", params: { name: tool, arguments: { sessionUuid } } },
        HANDLER_EXTRA,
      )
      .then(
        (result) => {
          const text = result.content[0]?.text ?? JSON.stringify(result);
          let error: { code?: unknown; nextAction?: unknown } | undefined;
          try {
            error = Reflect.get(Object(JSON.parse(text)), "error") as typeof error;
          } catch {
            error = undefined;
          }
          answer = {
            ok: result.isError !== true,
            ...(typeof error?.code === "string" ? { code: error.code } : {}),
            ...(typeof error?.nextAction === "string" ? { nextAction: error.nextAction } : {}),
            text,
          };
        },
        (error: unknown) => {
          answer = {
            ok: false,
            text: `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          };
        },
      );
    for (let step = 0; step < 400 && answer === undefined; step++) {
      await drainMicrotasks(64);
      if (answer === undefined) {
        await this.scenario.idle(100);
      }
    }
    await settleIo();
    return answer ?? { ok: false, text: "unanswered after 40 s" };
  }

  /** `ok`, the typed refusal code, or the raw text of an untyped answer. */
  async controlCall(execution: ManagedExecution, tool = "tapOn"): Promise<string> {
    const answer = await this.call(execution, tool);
    return answer.ok ? "ok" : (answer.code ?? answer.text);
  }

  /** Hold a session's device call until cancellation, or only teardown when wedged. */
  holdCall(sessionUuid: string, wedged = false): void {
    const gate = Promise.withResolvers<void>();
    const gates = Reflect.get(this.scenario, "gates") as Map<
      string,
      { opened: Promise<void>; wedged: boolean }
    >;
    gates.set(sessionUuid, { opened: gate.promise, wedged });
    // Keep every resolver, including a gate replaced by a later call on the same session.
    this.openCallGates.push(gate.resolve);
  }

  /** The first daemon ends; its PID is gone, and so is everything its process held in memory. */
  async endDaemon(kind: ShutdownKind): Promise<void> {
    await this.restart.end(kind);
    this.livePids.delete(this.pid);
    // Every daemon "process" of the scenario shares this test process's in-flight reservation
    // set. A dead process holds no reservation: without this its hung attempt would keep the
    // binding's `reserve-*` record live to the successor.
    const held = Reflect.get(ownerLivenessModule.inFlightBindingReservations, "ids") as Set<string>;
    for (const reservation of [...held]) {
      ownerLivenessModule.inFlightBindingReservations.delete(reservation);
    }
  }

  /** A successor process starts on the same session database and the same binding registry. */
  async startSuccessor(): Promise<void> {
    this.pid += 1;
    this.livePids.add(this.pid);
    // A new process reads the registry afresh: it has no snapshot of its own yet.
    this.exclusion = this.newExclusion();
    await this.restart.startSuccessor();
    await settleIo();
  }

  /**
   * Run `operation` on the registry as another daemon process on this host would see it: the same
   * file, judged with that process's own owner liveness. A peer holds none of this daemon's
   * sessions, so a record is live to it only while the recorded process runs.
   */
  async asPeerDaemon<T>(operation: (registry: BindingRegistry) => Promise<T>): Promise<T> {
    const mine = this.liveness;
    this.liveness = (owner) => this.livePids.has(owner.pid);
    try {
      return await operation(await this.registry());
    } finally {
      this.liveness = mine;
    }
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
      throw new Error(`ManagedRestartScenario: work did not settle in ${budgetMs} ms`);
    }
    return await tracked;
  }

  /** Advance the scenario clock, then let real I/O land. */
  async idle(ms: number): Promise<void> {
    await this.restart.idle(ms);
    await settleIo();
  }

  async binding(key: BindingKey): Promise<BindingSnapshot | null> {
    const registry = await this.registry();
    const assignment: BindingAssignmentRecord | null = await registry.getAssignment(key);
    if (!assignment) {
      return null;
    }
    const journal = await registry.listOpenBindingJournal(key);
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
    for (const open of this.openCallGates.splice(0)) {
      open();
    }
    // Let dispatched calls reach their bodies, then await the daemon-side execution ends. A
    // proxy may already have answered a timeout while its wedged body is still running.
    let drainFailure: Error | undefined;
    try {
      await settleIo();
      const drained = await this.during(
        Promise.all(
          this.executions.map((execution) =>
            execution.sessionUuid
              ? executionTracker.waitForDeviceSessionExecutionsToEnd(execution.sessionUuid, 20_000)
              : Promise.resolve(true),
          ),
        ),
        30_000,
        500,
      );
      const remaining = drained.filter((ended) => !ended).length;
      if (remaining > 0) {
        drainFailure = new Error(
          `ManagedRestartScenario: tool executions did not end during teardown (${remaining})`,
        );
      }
    } catch (error) {
      drainFailure = new Error(
        "ManagedRestartScenario: tool executions did not end during teardown",
        {
          cause: error,
        },
      );
    }
    const gates = Reflect.get(this.scenario, "gates") as Map<string, unknown>;
    gates.clear();
    for (const execution of this.executions.splice(0)) {
      await this.during(
        execution.closeServer().catch(() => undefined),
        30_000,
        500,
      ).catch(() => undefined);
    }
    await this.during(this.restart.stop(), 60_000, 500).catch(() => undefined);
    this.restoreExclusion?.();
    this.restoreTrackerTimer?.();
    await this.shared?.close();
    for (const spy of this.spies.splice(0)) {
      spy.mockRestore();
    }
    if (drainFailure) {
      throw drainFailure;
    }
  }
}
