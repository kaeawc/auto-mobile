import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_VERSION,
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
} from "../../src/daemon/constants";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type { DeviceSessionStatus } from "../../src/db/types";
import type { DevicePool, PooledDevice } from "../../src/daemon/devicePool";
import type { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

/*
 * H14 "monitor single-flight wedge" reproduction.
 *
 * The daemon's heartbeat monitor runs on a SingleFlightInterval: while one scan
 * is in flight, every later interval tick returns that same promise instead of
 * scanning (src/utils/SingleFlightInterval.ts:56-76). A scan awaits every reap it
 * started (src/daemon/SessionHeartbeatMonitor.ts:194), and the daemon's reap
 * awaits cancelAndReleaseSession with no deadline (src/daemon/daemon.ts:2440-2450).
 * On that release path the terminal-release persistence write
 * (sessionManager.ts:3144 persistTerminalReleaseWithUpgrade -> :3600
 * deviceSessionRepository.markReleased) has no deadline and runs BEFORE
 * removeSession (:3163). So one release write that never settles:
 *   - keeps the reaped session's own device busy, and
 *   - stops ALL heartbeat / cli-idle reaping daemon-wide.
 * Fallbacks while wedged: a heartbeat-policy session is freed only by the
 * SessionManager's own 5-minute cleanup sweep (:6028) once expiresAt (last
 * heartbeat + 30 min session timeout) plus suspect grace has passed. A cli-idle
 * session has no fallback: isSessionExpired is false for cli-idle (:5887), and
 * owner-disconnect release skips it (ownerDisconnectRelease.ts:61).
 *
 * Real production code driven: Daemon (constructor wiring, startHeartbeatMonitor,
 * cancelAndReleaseSession), SessionHeartbeatMonitor, SingleFlightInterval,
 * SessionManager (create, claim, heartbeat, CLI adoption, release, cleanup sweep),
 * DevicePool (assignDeviceToSession, expiry release handler, releaseDevice), the
 * daemon/heartbeat handler in handleDaemonRequest over the real DaemonState, and
 * DaemonMcpProxy's keeper (stdio proxy claim + 2 s heartbeats) and
 * adoptCliSessionLiveness (the `--cli` declaration).
 *
 * Faked: the clock (FakeTimer), device discovery (FakeDeviceManager), the
 * installed-apps store, the proxy<->daemon socket (a FakeDaemonClient that hands
 * daemon/heartbeat to handleDaemonRequest; the device tool result that mints the
 * session is canned), and session persistence (FakeDeviceSessionRepository). For
 * one chosen session, markReleased parks on a test-controlled gate. It stands in
 * for a write that never settles; the production cause of such a hang is NOT
 * shown here.
 */

const PROXY_HEARTBEAT_INTERVAL_MS = 2_000; // daemonMcpProxy.ts DAEMON_MCP_HEARTBEAT_INTERVAL_MS
const PROXY_HEARTBEAT_TIMEOUT_MS = 10_000; // SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS
const MONITOR_INTERVAL_MS = 10_000; // SessionHeartbeatMonitor DEFAULT_CHECK_INTERVAL_MS
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const HUNG = "hung-reap-session";
const DEAD = "dead-proxy-session";
const CLI = "idle-cli-session";

/** Session persistence whose release write for chosen sessions does not settle until `unpark()`. */
class ReleaseParkingRepository extends FakeDeviceSessionRepository {
  readonly parkedReleases: string[] = [];
  private readonly gate = Promise.withResolvers<void>();

  constructor(private readonly parkFor: ReadonlySet<string>) {
    super();
  }

  // The base DeviceSessionRepository would resolve the real DB; a proxy's claim persists here.
  override async recordLivenessOwnership(): Promise<void> {}

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    if (this.parkFor.has(sessionUuid)) {
      this.parkedReleases.push(sessionUuid);
      await this.gate.promise;
    }
    await super.markReleased(sessionUuid, status, releasedAtMs, reason);
  }

  unpark(): void {
    this.gate.resolve();
  }
}

/**
 * A proxy's daemon socket. daemon/heartbeat goes to the daemon's real request
 * handler, and a failure is mapped to a thrown error the way DaemonClient does.
 * Everything else keeps FakeDaemonClient's canned answers. `sever()` models the
 * owner process dying: nothing it sends reaches the daemon afterwards.
 */
class DaemonHandlerBridgeClient extends FakeDaemonClient {
  private severed = false;
  private requestSeq = 0;

  sever(): void {
    this.severed = true;
  }

  override async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    if (this.severed) {
      throw new DaemonUnavailableError("Socket connection lost");
    }
    const canned = await super.callDaemonMethod(method, params);
    if (method !== DAEMON_HEARTBEAT_METHOD) {
      return canned;
    }
    const response = await handleDaemonRequest(
      { id: `bridge-${++this.requestSeq}`, type: "daemon_request", method, params },
      DaemonState.getInstance(),
    );
    if (!response.success) {
      throw Object.assign(new Error(response.error ?? "daemon request failed"), {
        code: response.code,
      });
    }
    return response.result;
  }
}

interface DaemonMonitorInternals {
  heartbeatMonitor: { stop(): Promise<void> } | null;
  startHeartbeatMonitor(): void;
}

interface Owner {
  client: DaemonHandlerBridgeClient;
  proxy: DaemonMcpProxy;
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

/** A real DaemonMcpProxy that has acquired `sessionUuid`; its keeper then heartbeats it. */
async function acquireThroughProxy(
  timer: FakeTimer,
  sessionUuid: string,
  token: string,
): Promise<Owner> {
  const client = new DaemonHandlerBridgeClient({
    toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult(sessionUuid) : undefined),
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    livenessOwnerToken: token,
    heartbeatTimeoutMs: PROXY_HEARTBEAT_TIMEOUT_MS,
    heartbeatIntervalMs: PROXY_HEARTBEAT_INTERVAL_MS,
  });
  await proxy.callTool("getAndroid", {});
  return { client, proxy };
}

/** The owner process exits without releasing: its socket is gone and its keeper stops. */
async function exitWithoutRelease(owner: Owner): Promise<void> {
  owner.client.sever();
  await owner.proxy.close();
}

interface Scenario {
  timer: FakeTimer;
  repository: ReleaseParkingRepository;
  daemon: Daemon;
  manager: SessionManager;
  holder(sessionId: string): PooledDevice | undefined;
  owners: Owner[];
  deadOwner: Owner;
  cliLastActivity: number;
}

/** Microtask-only stepping: the harness is promise-driven, so no host event-loop turns. */
const step = (turns: number) => () => drainMicrotasks(turns);

/**
 * Three pooled devices, each held by a session a real proxy owns:
 * - HUNG: its stdio proxy dies at t=2 s, so the t=30 s scan reaps it;
 * - DEAD: its stdio proxy keeps the 2 s keeper running (the test kills it later);
 * - CLI: a `--cli` invocation declares it CLI-owned at t=2 s and exits (10 min idle).
 */
async function startScenario(parkReleaseFor: ReadonlySet<string>): Promise<Scenario> {
  const timer = new FakeTimer();
  const repository = new ReleaseParkingRepository(parkReleaseFor);
  const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
  const manager = daemon.getSessionManager();
  const pool = daemon.getDevicePool();
  const devices: BootedDevice[] = [
    { name: "Pixel Hung", deviceId: "device-hung", platform: "android" },
    { name: "Pixel Dead", deviceId: "device-dead", platform: "android" },
    { name: "Pixel Cli", deviceId: "device-cli", platform: "android" },
  ];
  const discovery = new FakeDeviceManager();
  discovery.bootedDevices = [...devices];
  Object.assign(pool as DevicePool, { deviceManager: discovery });
  await pool.initializeWithDevices(devices);
  const deviceOf: Record<string, string> = {};
  for (const sessionId of [HUNG, DEAD, CLI]) {
    deviceOf[sessionId] = await pool.assignDeviceToSession(sessionId, "android");
  }

  const hungOwner = await acquireThroughProxy(timer, HUNG, "token-hung");
  const deadOwner = await acquireThroughProxy(timer, DEAD, "token-dead");
  const cliOwner = await acquireThroughProxy(timer, CLI, "token-cli");
  (daemon as unknown as DaemonMonitorInternals).startHeartbeatMonitor();

  // t=2s: one keeper tick. Each proxy claims liveness ownership and heartbeats its
  // session through the daemon's real daemon/heartbeat handler.
  await timer.advanceTimeAsync(PROXY_HEARTBEAT_INTERVAL_MS, step(50));
  for (const [sessionId, token] of [
    [HUNG, "token-hung"],
    [DEAD, "token-dead"],
    [CLI, "token-cli"],
  ]) {
    expect(manager.getSession(sessionId)).toMatchObject({
      livenessOwnerToken: token,
      hasReceivedHeartbeat: true,
      lastOwnerHeartbeat: PROXY_HEARTBEAT_INTERVAL_MS,
    });
  }

  // The `--cli` invocation declares its session CLI-owned (#6870), then exits.
  expect(await cliOwner.proxy.adoptCliSessionLiveness()).toBe(CLI);
  await exitWithoutRelease(cliOwner);
  expect(manager.getSession(CLI)).toMatchObject({
    livenessPolicy: "cli-idle",
    heartbeatTimeoutMs: DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  });

  // HUNG's stdio proxy dies now. DEAD's proxy keeps heartbeating.
  await exitWithoutRelease(hungOwner);

  return {
    timer,
    repository,
    daemon,
    manager,
    holder: (sessionId) => pool.getDevice(deviceOf[sessionId]),
    owners: [hungOwner, deadOwner, cliOwner],
    deadOwner,
    cliLastActivity: manager.getSession(CLI)!.lastHeartbeat,
  };
}

async function stopScenario(scenario: Scenario | undefined): Promise<void> {
  if (!scenario) {
    return;
  }
  for (const owner of scenario.owners) {
    await exitWithoutRelease(owner);
  }
  scenario.repository.unpark();
  await drainMicrotasks(50);
  void (scenario.daemon as unknown as DaemonMonitorInternals).heartbeatMonitor?.stop();
  scenario.manager.stopCleanupTimer();
}

describe("H14: one never-settling reap wedges the daemon heartbeat monitor", () => {
  let appearanceSync: ReturnType<typeof spyOn>;
  let isAvailable: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  let logs: string[];
  let scenario: Scenario | undefined;

  beforeEach(() => {
    resetDbWriteBarrier();
    logs = [];
    scenario = undefined;
    appearanceSync = spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(
      undefined,
    );
    isAvailable = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warn = spyOn(logger, "warn").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    info = spyOn(logger, "info").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
  });

  afterEach(async () => {
    await stopScenario(scenario);
    appearanceSync.mockRestore();
    isAvailable.mockRestore();
    warn.mockRestore();
    info.mockRestore();
    SessionReleaseBroadcaster.clearForTesting();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  /** Session ids in the order the monitor logged "<id> ..., cancelling (reason=...)". */
  const cancelledByMonitor = (): string[] =>
    logs
      .map((line) => /^Session (\S+) .*, cancelling \(reason=/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);

  test("control: with every release write settling, the monitor frees DEAD at 70 s and CLI at 10m10s", async () => {
    scenario = await startScenario(new Set());
    const { timer, repository, manager, holder, deadOwner } = scenario;

    await timer.advanceTimeAsync(30 * SECOND - timer.now(), step(50));
    expect(cancelledByMonitor()).toEqual([HUNG]);
    expect(holder(HUNG)).toMatchObject({ status: "idle", sessionId: null });

    await timer.advanceTimeAsync(40 * SECOND - timer.now(), step(50));
    await exitWithoutRelease(deadOwner);
    await timer.advanceTimeAsync(70 * SECOND - timer.now(), step(50));
    expect(cancelledByMonitor()).toEqual([HUNG, DEAD]);
    expect(holder(DEAD)).toMatchObject({ status: "idle", sessionId: null });

    await timer.advanceTimeAsync(10 * MINUTE + 10 * SECOND - timer.now(), step(50));
    expect(cancelledByMonitor()).toEqual([HUNG, DEAD, CLI]);
    expect(holder(CLI)).toMatchObject({ status: "idle", sessionId: null });
    expect(repository.sessions.get(CLI)).toMatchObject({ reason: "cli-idle-timeout" });
    expect(manager.getSession(CLI)).toBeNull();
  });

  test("current behavior: a parked release write holds a dead proxy's device ~35 min and an idle --cli device for hours", async () => {
    scenario = await startScenario(new Set([HUNG]));
    const { timer, repository, manager, holder, deadOwner, cliLastActivity } = scenario;

    // t=30s: the scan reaps HUNG (10 s lease + 10 s suspect grace have lapsed). Its
    // terminal-release write parks, so this scan, the single flight, never settles.
    await timer.advanceTimeAsync(30 * SECOND - timer.now(), step(50));
    await drainUntil(() => repository.parkedReleases.length > 0, {
      description: "the HUNG reap reaching markReleased",
    });
    expect(cancelledByMonitor()).toEqual([HUNG]);
    expect(repository.parkedReleases).toEqual([HUNG]);
    // HUNG is fenced as terminally released, yet its device stays busy.
    expect(manager.getTerminalReleaseSnapshot(HUNG)).toMatchObject({
      releaseReason: "heartbeat-timeout",
    });
    expect(holder(HUNG)).toMatchObject({ status: "busy", sessionId: HUNG });
    expect(manager.getSessionLeaseState(DEAD)?.phase).toBe("live");

    // t=40s: DEAD's stdio proxy dies too, without releasing anything.
    await timer.advanceTimeAsync(40 * SECOND - timer.now(), step(50));
    await exitWithoutRelease(deadOwner);
    expect(manager.getSession(DEAD)?.lastOwnerHeartbeat).toBe(40 * SECOND);

    // The control test shows the monitor reaping DEAD at 70 s and CLI at 10m10s. Here,
    // every interval tick until t=35m just returns the in-flight scan.
    await timer.advanceTimeAsync(35 * MINUTE - 1 - timer.now(), step(20));
    expect(cancelledByMonitor()).toEqual([HUNG]);
    expect(manager.getSessionLeaseState(DEAD)?.phase).toBe("lapsed");
    expect(holder(DEAD)).toMatchObject({ status: "busy", sessionId: DEAD });
    expect(holder(CLI)).toMatchObject({ status: "busy", sessionId: CLI });
    expect(holder(HUNG)).toMatchObject({ status: "busy", sessionId: HUNG });

    // t=35m: only the SessionManager's own 5-minute cleanup sweep frees DEAD. It does so
    // once expiresAt (last heartbeat + 30 min) plus the 10 s suspect grace has passed.
    await timer.advanceTimeAsync(1, step(50));
    await drainUntil(() => holder(DEAD)?.status === "idle", {
      description: "the cleanup sweep freeing DEAD's device",
    });
    expect(logs).toContain(`Cleaning up 1 expired sessions: ${DEAD}`);
    expect(repository.sessions.get(DEAD)).toMatchObject({
      status: "expired",
      reason: "heartbeat-timeout",
    });
    expect(cancelledByMonitor()).toEqual([HUNG]);

    // t=3h: the idle `--cli` session has no fallback, so its device is still locked about
    // 18x past its 10-minute idle timeout. HUNG's own device is still locked too.
    await timer.advanceTimeAsync(3 * HOUR - timer.now(), step(20));
    expect(manager.getSession(CLI)).not.toBeNull();
    expect(timer.now() - cliLastActivity).toBeGreaterThan(17 * DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS);
    expect(holder(CLI)).toMatchObject({ status: "busy", sessionId: CLI });
    expect(holder(HUNG)).toMatchObject({ status: "busy", sessionId: HUNG });
    expect(cancelledByMonitor()).toEqual([HUNG]);

    // Causality: once the parked write settles, the wedged scan completes and the very
    // next scan reaps CLI. Only the in-flight scan was holding it.
    repository.unpark();
    await drainUntil(() => logs.some((line) => line.startsWith(`Cancelled session ${HUNG} `)), {
      description: "the HUNG reap completing once its write settles",
    });
    // Let the settled reap unwind through tickOnce and SingleFlightInterval's clear.
    await drainMicrotasks(20);
    expect(holder(HUNG)).toMatchObject({ status: "idle", sessionId: null });
    await timer.advanceTimeAsync(MONITOR_INTERVAL_MS, step(50));
    await drainUntil(() => holder(CLI)?.status === "idle", {
      description: "the next scan reaping the idle CLI session",
    });
    expect(cancelledByMonitor()).toEqual([HUNG, CLI]);
    expect(repository.sessions.get(CLI)).toMatchObject({ reason: "cli-idle-timeout" });

    // AFTER A FIX (one hung reap must not stop other sessions being reaped), with HUNG's
    // write still parked, this should hold instead:
    //   by t=70s:    cancelledByMonitor() includes DEAD and holder(DEAD) is idle;
    //   by t=10m10s: cancelledByMonitor() includes CLI and holder(CLI) is idle,
    //                with reason "cli-idle-timeout";
    //   meanwhile HUNG is not re-reaped every scan: it is logged "cancelling" once.
  });
});
