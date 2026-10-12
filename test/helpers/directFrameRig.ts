import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { spyOn } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import type { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "./fakeTimerStepping";
import {
  createFakeDaemonState,
  createFakeDeviceManager,
} from "../daemon/helpers/inputSocketHarness";

/**
 * Rig for direct socket frame ownership and cancellation regressions (#11667).
 *
 * Real: `UnixSocketServer`'s connection handler (framing, the per-socket admission queue, the
 * `input/*` and `ide/*` routes, gesture ownership), `SessionManager`, and the process execution
 * tracker. Fake: the kernel socket (an in-process emitter handed to `handleConnection`), device
 * discovery, and the Android device client, which records what reached the device.
 *
 * The session hooks are wired as production wires them: `daemon.ts` gives the session manager the
 * acquisition canceller that lifts sessionless strokes, and `socketServer.start()` subscribes the
 * release that lifts a released holder's strokes.
 */

export class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
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
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
  answer(id: string): DaemonResponse | undefined {
    return this.responses.find((frame) => frame.id === id);
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  mcpForwardTails: Map<string, Promise<void>>;
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
  liftSessionlessStrokesOn(deviceId: string): void;
}

export interface DeviceClientFake {
  onRead?: () => void;
  ownershipGate?: () => Promise<void>;
  updateService?: () => Promise<void>;
  onDeviceCall?: (deviceId: string, method: string) => void;
  requestGestureEnd?: () => Promise<{ success: boolean }>;
  requestGestureStart?: (gestureId: string) => Promise<{ success: boolean; error?: string }>;
  setPreference?: (...args: unknown[]) => Promise<void>;
  clearPreferenceStore?: (...args: unknown[]) => Promise<void>;
  /** Awaited by every device discovery before it answers. */
  discovery?: () => Promise<void>;
}

export interface DirectFrameRig {
  sessionManager: SessionManager;
  /** What reached a device, in order: `<deviceId>:<start|move|end|cancel|...>`. */
  deviceCalls: string[];
  isDeviceWorkQueued(deviceId: string): boolean;
  connect(): FakeSocket;
  settle(): Promise<void>;
  /** Send one frame and wait for the server to go quiet; resolves with its answer, if any. */
  request(socket: FakeSocket, request: DaemonRequest): Promise<DaemonResponse | undefined>;
  dispose(): Promise<void>;
}

export function android(deviceId: string): BootedDevice {
  return { deviceId, name: deviceId, platform: "android" };
}

export function createDirectFrameRig(
  devices: BootedDevice[],
  client: DeviceClientFake = {},
): DirectFrameRig {
  const deviceCalls: string[] = [];
  const sockets: FakeSocket[] = [];
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };
  const sessionManager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
  sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
    hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
  );
  const unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);

  const discovered = createFakeDeviceManager(devices);
  PlatformDeviceManagerFactory.setInstance({
    getBootedDevicesDetailed: async (
      ...args: Parameters<typeof discovered.getBootedDevicesDetailed>
    ) => {
      await client.discovery?.();
      return discovered.getBootedDevicesDetailed(...args);
    },
  } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation((device) => {
    const called = (what: string) => {
      deviceCalls.push(`${device.deviceId}:${what}`);
      client.onDeviceCall?.(device.deviceId, what);
    };
    return {
      getScreenScaleMetadata: () => null,
      requestGestureStart: async (gestureId: string) => {
        called("start");
        return (await client.requestGestureStart?.(gestureId)) ?? { success: true };
      },
      requestGestureMove: async () => {
        called("move");
        return { success: true };
      },
      requestGestureEnd: async (_id: string, _x: number, _y: number, cancel?: boolean) => {
        called(cancel === true ? "cancel" : "end");
        return (await client.requestGestureEnd?.()) ?? { success: true };
      },
      setPreference: async (...args: Parameters<AndroidCtrlProxyClient["setPreference"]>) => {
        if (typeof args[5] === "object") {
          args[5].onDispatch?.();
        }
        called("setPreference");
        await client.setPreference?.(...args);
      },
      removePreference: async (...args: Parameters<AndroidCtrlProxyClient["removePreference"]>) => {
        if (typeof args[3] === "object") {
          args[3].onDispatch?.();
        }
        called("removePreference");
      },
      clearPreferenceStore: async (
        ...args: Parameters<AndroidCtrlProxyClient["clearPreferenceStore"]>
      ) => {
        if (typeof args[2] === "object") {
          args[2].onDispatch?.();
        }
        called("clearPreferenceStore");
        await client.clearPreferenceStore?.(...args);
      },
    } as unknown as AndroidCtrlProxyClient;
  });

  const updateServiceSpy = client.updateService
    ? spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
        (device) =>
          ({
            ensureCompatibleVersion: async () => {
              deviceCalls.push(`${device.deviceId}:updateService`);
              await client.updateService?.();
              return { status: "compatible" };
            },
          }) as unknown as AndroidCtrlProxyManager,
      )
    : undefined;

  const fakePool = {
    ...createFakeDaemonState().getDevicePool(),
    assertNotClaimedByForeignDaemon: async () => {
      await client.ownershipGate?.();
    },
  };
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => fakePool,
    } as unknown as DaemonStateAccess,
    new FakeTimer(),
    {
      listFlags: async () => {
        client.onRead?.();
        return [];
      },
    } as unknown as FeatureFlagService,
    // The storage tools are enabled, so an `ide/*` storage frame reaches its ownership gate.
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  );
  const internals = server as unknown as Internals;
  internals.acceptingRequests = true;
  // daemon.ts: a session acquiring a device cancels the sessionless work admitted on it.
  sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
    executionTracker.cancelSessionlessDeviceUse(deviceId);
    internals.liftSessionlessStrokesOn(deviceId);
  });
  // daemon.ts: queue holder strokes on the old device synchronously at unbind.
  sessionManager.onSessionDeviceUnbound((sessionId, deviceId) =>
    server.liftStrokesHeldByOn(sessionId, deviceId),
  );
  // socketServer.start(): a released session's strokes are lifted.
  sessionManager.onSessionRelease((sessionId) => void internals.liftStrokesHeldBy(sessionId));

  async function settle(): Promise<void> {
    // Negative assertions include queued no-ops and deliberately pending calls; drain their
    // await chains without depending on real event-loop scheduling.
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
  }

  return {
    sessionManager,
    deviceCalls,
    settle,
    isDeviceWorkQueued: (deviceId) => internals.mcpForwardTails.has(`device:${deviceId}`),
    connect() {
      const socket = new FakeSocket();
      sockets.push(socket);
      internals.handleConnection(socket as unknown as Socket);
      return socket;
    },
    async request(socket, request) {
      socket.send(request);
      await settle();
      return socket.answer(request.id);
    },
    async dispose() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await settle();
      await Promise.allSettled([...internals.activeRequestHandlers]);
      unsubscribeActivity();
      updateServiceSpy?.mockRestore();
      spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
      PlatformDeviceManagerFactory.reset();
      sessionManager.stopCleanupTimer();
    },
  };
}

export function gestureFrame(
  kind: "Start" | "Move" | "End",
  deviceId: string,
  extra: Record<string, unknown> = {},
): DaemonRequest {
  return {
    id: `gesture-${kind}-${deviceId}`,
    type: "mcp_request",
    method: `input/gesture${kind}`,
    params: { platform: "android", deviceId, x: 1, y: 2, gestureId: "drag-1", ...extra },
  };
}
