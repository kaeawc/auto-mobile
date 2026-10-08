import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { spyOn } from "bun:test";
import { DAEMON_OWNED_SESSIONS_PARAM } from "../../../src/daemon/constants";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { ObserverSessionRegistry } from "../../../src/daemon/observerSessionRegistry";
import { releaseSessionAndDevice } from "../../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager, TerminalSessionError } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { sessionOwnershipLostPayload } from "../../../src/server/deviceSessionResult";
import { executionTracker } from "../../../src/server/executionTracker";
import { createSetActiveDeviceHandler } from "../../../src/server/setActiveDevice";
import { shapeToolCallError } from "../../../src/server/shapeToolCallError";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../../src/utils/logger";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { createFakeDeviceManager } from "./inputSocketHarness";

/**
 * Drives the REAL daemon request handlers with the frames the desktop/IDE client
 * (the desktop-core Gradle module) sends, and records each request/response pair as a
 * desktop wire fixture (#10669).
 *
 * - `daemon/*` and `input/*` frames go through the real {@link UnixSocketServer}
 *   connection handler, so the response envelope is the one the socket writes.
 * - `tools/call setActiveDevice` runs the real tool handler and maps a thrown
 *   error exactly as `src/server/index.ts`'s tool-call catch block does
 *   (`TerminalSessionError` -> `sessionOwnershipLostPayload`, anything else ->
 *   `shapeToolCallError`), wrapped in the socket's `success: true` envelope that a
 *   forwarded MCP result rides in. The call is a tracked execution under its
 *   `sessionUuid`, so its end restarts the session's idle window as in production.
 * - Idle release and heartbeat expiry run on {@link FakeTimer}: the
 *   SessionManager's own cleanup interval plus the daemon's
 *   {@link SessionHeartbeatMonitor} reaper, wired as `daemon.ts` wires them.
 */

export const DESKTOP_HEARTBEAT_MS = 2_000; // DesktopDaemonSessionComposition.kt HEARTBEAT_INTERVAL_MS
export const DESKTOP_CLIENT_NAME = "AutoMobile Desktop"; // DesktopDaemonSession.kt

export const PIXEL: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
export const PIXEL_FOLD: BootedDevice = {
  deviceId: "emulator-5556",
  name: "Pixel Fold",
  platform: "android",
};

export type WireActor = "desktop" | "agent" | "probe";

export interface WireExchange {
  /** Fake-clock time of the request, relative to the scenario start. */
  atMs: number;
  actor: WireActor;
  /** Step name a consumer looks responses up by. */
  label: string;
  /** Present when one exchange stands for this many identical consecutive requests. */
  repeat?: number;
  everyMs?: number;
  request: { method: string; params: Record<string, unknown> };
  response: { success: boolean; result?: unknown; error?: string; code?: string };
}

export interface WireFixture {
  $comment: string;
  scenario: string;
  description: string;
  sessions: Record<string, string>;
  exchanges: WireExchange[];
}

class RecordingSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  private readonly waiters = new Map<string, (response: DaemonResponse) => void>();
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    for (const line of data.split("\n").filter((chunk) => chunk.length > 0)) {
      const response = JSON.parse(line) as DaemonResponse;
      this.waiters.get(response.id)?.(response);
      this.waiters.delete(response.id);
    }
    callback?.();
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
  request(request: DaemonRequest): Promise<DaemonResponse> {
    const response = new Promise<DaemonResponse>((resolve) => {
      this.waiters.set(request.id, resolve);
    });
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
    return response;
  }
}

interface SocketServerInternals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
}

const setActiveDeviceTool = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });

/** One daemon process: real SessionManager, DevicePool, registries and socket handler. */
class DaemonUnderTest {
  readonly manager: SessionManager;
  readonly pool: DevicePool;
  readonly monitor: SessionHeartbeatMonitor;
  private readonly socket = new RecordingSocket();
  private readonly unsubscribe: () => void;

  private constructor(
    readonly timer: FakeTimer,
    pool: DevicePool,
    manager: SessionManager,
  ) {
    this.manager = manager;
    this.pool = pool;
    DaemonState.getInstance().initialize(
      manager,
      pool,
      new DeviceSessionRegistry(),
      new ObserverSessionRegistry(timer),
    );
    // daemon.ts subscribeToolCallEndActivity: a tool call's END restarts the idle window.
    this.unsubscribe = executionTracker.onSessionExecutionEnded((uuids) => {
      for (const uuid of uuids) {
        manager.recordToolCallEnded(uuid);
      }
      pool.sessionExecutionsEnded(new Set(uuids));
    });
    manager.setActiveSessionExecutionChecker((sessionId) =>
      executionTracker.hasActiveSessionUuidExecutions(sessionId),
    );
    // daemon.ts wires the reaper's release to releaseSessionAndDevice.
    this.monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    this.monitor.start();
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      DaemonState.getInstance(),
      timer,
    ) as unknown as SocketServerInternals;
    server.acceptingRequests = true;
    server.handleConnection(this.socket as unknown as Socket);
  }

  static async start(timer: FakeTimer, devices: BootedDevice[]): Promise<DaemonUnderTest> {
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", devices);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "desktop-wire-daemon", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices(devices);
    return new DaemonUnderTest(timer, pool, manager);
  }

  socketRequest(request: DaemonRequest): Promise<DaemonResponse> {
    return this.socket.request(request);
  }

  async stop(): Promise<void> {
    this.socket.destroy();
    await this.monitor.stop();
    this.manager.stopCleanupTimer();
    this.unsubscribe();
    DaemonState.getInstance().reset();
  }
}

/** A recorded scenario: every frame is answered by the real handlers and appended to the fixture. */
export class DesktopWireHarness {
  readonly timer = new FakeTimer();
  readonly exchanges: WireExchange[] = [];
  private daemon!: DaemonUnderTest;
  private frameSeq = 0;
  private readonly restore: Array<{ mockRestore(): void }> = [];

  constructor(private readonly devices: BootedDevice[] = [PIXEL, PIXEL_FOLD]) {}

  get manager(): SessionManager {
    return this.daemon.manager;
  }

  get pool(): DevicePool {
    return this.daemon.pool;
  }

  async start(): Promise<void> {
    this.restore.push(
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        () =>
          ({
            getScreenScaleMetadata: () => null,
            requestTapCoordinates: async () => ({ success: true }),
          }) as unknown as AndroidCtrlProxyClient,
      ),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager(this.devices));
    this.daemon = await DaemonUnderTest.start(this.timer, this.devices);
  }

  /** Models a daemon restart: a fresh process with no memory of earlier sessions. */
  async restartDaemon(): Promise<void> {
    await this.daemon.stop();
    this.daemon = await DaemonUnderTest.start(this.timer, this.devices);
  }

  async stop(): Promise<void> {
    await this.daemon.stop();
    PlatformDeviceManagerFactory.reset();
    for (const spy of this.restore.splice(0)) {
      spy.mockRestore();
    }
  }

  /** Step the fake clock, letting the cleanup interval and reaper sweeps settle. */
  async advance(ms: number): Promise<void> {
    await this.timer.advanceTimeAsync(ms, () => drainMicrotasks(40));
  }

  async send(
    actor: WireActor,
    label: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<WireExchange["response"]> {
    const exchange = await this.exchange(actor, label, method, params);
    this.exchanges.push(exchange);
    return exchange.response;
  }

  /** Sessions another client keeps alive (the agent's proxy keeper); their beats are not recorded. */
  readonly keepAlive = new Set<string>();

  /** The device's current holder in the real pool, or null when it is idle. */
  holderOf(deviceId: string): string | null {
    return this.pool.getDevice(deviceId)?.sessionId ?? null;
  }

  /** Let fake time pass with no desktop frame (a stalled or sleeping client). */
  async stall(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += DESKTOP_HEARTBEAT_MS) {
      await this.passTick();
    }
  }

  /**
   * The desktop's steady state: `count` heartbeat ticks, each {@link DESKTOP_HEARTBEAT_MS} apart.
   * Every response must be identical; the run is recorded as one exchange with `repeat`.
   */
  async heartbeats(
    label: string,
    sessionId: string,
    count: number,
  ): Promise<WireExchange["response"]> {
    const { healthy, changed } = await this.heartbeatRun(label, sessionId, count);
    if (changed) {
      throw new Error(
        `${label}: heartbeat ${healthy.length + 1}/${count} answered ` +
          `${JSON.stringify(changed.response)}, not ${JSON.stringify(healthy[0]!.response)}`,
      );
    }
    this.exchanges.push(collapse(healthy));
    return healthy[0]!.response;
  }

  /**
   * Heartbeat until the answer changes (the daemon stops recognising the session), recording the
   * steady run under `label` and the first changed beat under `${label}-lapse`. Returns the length
   * of the steady run.
   */
  async heartbeatsUntilLapse(label: string, sessionId: string, maxTicks: number): Promise<number> {
    const { healthy, changed } = await this.heartbeatRun(label, sessionId, maxTicks);
    if (!changed) {
      throw new Error(`${label}: session ${sessionId} never lapsed within ${maxTicks} ticks`);
    }
    this.exchanges.push(collapse(healthy), { ...changed, label: `${label}-lapse` });
    return healthy.length;
  }

  private async heartbeatRun(
    label: string,
    sessionId: string,
    maxTicks: number,
  ): Promise<{ healthy: WireExchange[]; changed?: WireExchange }> {
    const healthy: WireExchange[] = [];
    for (let tick = 0; tick < maxTicks; tick++) {
      await this.passTick();
      const exchange = await this.exchange("desktop", label, "daemon/heartbeat", { sessionId });
      if (healthy.length > 0 && !sameResponse(healthy[0]!, exchange)) {
        return { healthy, changed: exchange };
      }
      healthy.push(exchange);
    }
    return { healthy };
  }

  /** One desktop loop interval: fake time advances and kept-alive sessions beat. */
  private async passTick(): Promise<void> {
    await this.advance(DESKTOP_HEARTBEAT_MS);
    for (const sessionId of this.keepAlive) {
      await this.daemon.socketRequest({
        id: `keepalive-${++this.frameSeq}`,
        type: "mcp_request",
        method: "daemon/heartbeat",
        params: { sessionId },
      });
    }
  }

  fixture(scenario: string, description: string, sessions: Record<string, string>): WireFixture {
    return {
      $comment:
        "Generated by test/daemon/desktopWireContract.test.ts from the real daemon handlers; " +
        "regenerate with `UPDATE_CAPTURED_FIXTURES=1 bun test test/daemon/desktopWireContract.test.ts`. Do not edit by hand.",
      scenario,
      description,
      sessions,
      exchanges: this.exchanges,
    };
  }

  private async exchange(
    actor: WireActor,
    label: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<WireExchange> {
    const atMs = this.timer.now();
    const response =
      method === "tools/call"
        ? await this.callTool(params)
        : await this.daemon.socketRequest({
            id: `desktop-wire-${++this.frameSeq}`,
            type: "mcp_request",
            method,
            params,
          });
    return {
      atMs,
      actor,
      label,
      request: { method, params },
      response: envelopeOf(response),
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<DaemonResponse> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown> & { sessionUuid?: string };
    if (name !== "setActiveDevice") {
      throw new Error(`desktop wire harness does not route tools/call ${String(name)}`);
    }
    // The socket server strips its routing params before forwarding (withSocketSessionAutolockKey);
    // restoring the owned-session list only re-attaches live sessions to the socket's MCP
    // session, which these scenarios do not observe.
    const forwarded: Record<string, unknown> = { ...args };
    delete forwarded[DAEMON_OWNED_SESSIONS_PARAM];
    const execution = executionTracker.startExecution(name, undefined, args.sessionUuid);
    try {
      const result = await setActiveDeviceTool(
        forwarded as Parameters<typeof setActiveDeviceTool>[0],
      );
      return { id: "tool", type: "mcp_response", success: true, result };
    } catch (error) {
      return { id: "tool", type: "mcp_response", success: true, result: toolErrorResult(error) };
    } finally {
      executionTracker.endExecution(execution.id);
      await drainMicrotasks(40);
    }
  }
}

/** src/server/index.ts tool-call catch block, for the errors setActiveDevice can raise. */
function toolErrorResult(error: unknown): unknown {
  if (error instanceof TerminalSessionError) {
    const payload = sessionOwnershipLostPayload({
      message: error.message,
      sessionUuid: error.sessionUuid,
      reason: error.release.releaseReason,
      release: error.release,
    });
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
  return shapeToolCallError(error, { toolName: "setActiveDevice", source: "MCP" });
}

function sameResponse(a: WireExchange, b: WireExchange): boolean {
  return JSON.stringify(a.response) === JSON.stringify(b.response);
}

function collapse(run: WireExchange[]): WireExchange {
  const first = run[0]!;
  return run.length > 1 ? { ...first, repeat: run.length, everyMs: DESKTOP_HEARTBEAT_MS } : first;
}

/** The socket envelope minus its per-request `id` and constant `type`. */
function envelopeOf(response: DaemonResponse): WireExchange["response"] {
  return Object.fromEntries(
    Object.entries(response).filter(([key]) => key !== "id" && key !== "type"),
  ) as WireExchange["response"];
}
