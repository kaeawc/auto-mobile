import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import type { GestureStartRequest } from "../../src/features/observe/android/CtrlProxyGestures";
import { createHarnessServer } from "../daemon/helpers/UnixSocketServerHarness";
import { FakeSocket as SharedFakeSocket } from "../fakes/FakeNetServer";
import { spyOn } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import type { FeatureFlagKey } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagAdmin } from "../../src/features/featureFlags/FeatureFlagService";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
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

export class FakeSocket extends SharedFakeSocket {
  answer(id: string): DaemonResponse | undefined {
    return this.responses.find((frame) => frame.id === id);
  }
}

export interface DeviceClientFake {
  onRead?: () => void;
  ownershipGate?: () => Promise<void>;
  updateService?: () => Promise<void>;
  onDeviceCall?: (deviceId: string, method: string) => void;
  requestGestureEnd?: () => Promise<{ success: boolean }>;
  requestGestureStart?: (
    request: GestureStartRequest,
  ) => Promise<{ success: boolean; error?: string }>;
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
  const discoverDevices = discovered.getBootedDevicesDetailed.bind(discovered);
  discovered.getBootedDevicesDetailed = async (...args) => {
    await client.discovery?.();
    return discoverDevices(...args);
  };
  PlatformDeviceManagerFactory.setInstance(discovered);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation((device) => {
    const called = (what: string) => {
      deviceCalls.push(`${device.deviceId}:${what}`);
      client.onDeviceCall?.(device.deviceId, what);
    };
    const overrides = {
      getScreenScaleMetadata: () => null,
      requestGestureStart: async (request: GestureStartRequest) => {
        called("start");
        return {
          totalTimeMs: 0,
          ...((await client.requestGestureStart?.(request)) ?? { success: true }),
        };
      },
      requestGestureMove: async () => {
        called("move");
        return { success: true, totalTimeMs: 0 };
      },
      requestGestureEnd: async (_id: string, _x: number, _y: number, cancel?: boolean) => {
        called(cancel === true ? "cancel" : "end");
        return { totalTimeMs: 0, ...((await client.requestGestureEnd?.()) ?? { success: true }) };
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
    };
    const proxy = new FakeCtrlProxy();
    proxy.getScreenScaleMetadata = overrides.getScreenScaleMetadata;
    proxy.requestGestureStart = overrides.requestGestureStart;
    proxy.requestGestureMove = overrides.requestGestureMove;
    proxy.requestGestureEnd = overrides.requestGestureEnd;
    proxy.setPreference = overrides.setPreference;
    proxy.removePreference = overrides.removePreference;
    proxy.clearPreferenceStore = overrides.clearPreferenceStore;
    return proxy;
  });

  const updateServiceSpy = client.updateService
    ? spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation((device) => {
        const manager = new FakeCtrlProxyManager();
        const ensureCompatibleVersion = manager.ensureCompatibleVersion.bind(manager);
        manager.ensureCompatibleVersion = async (options) => {
          deviceCalls.push(`${device.deviceId}:updateService`);
          await client.updateService?.();
          return ensureCompatibleVersion(options);
        };
        return manager;
      })
    : undefined;

  const fakePool = {
    ...createFakeDaemonState().getDevicePool(),
    assertNotClaimedByForeignDaemon: async () => {
      await client.ownershipGate?.();
    },
  };
  const server = createHarnessServer(
    "unused",
    {
      ...createFakeDaemonState(),
      getSessionManager: () => sessionManager,
      getDevicePool: () => fakePool,
    },
    new FakeTimer(),
    {
      listFlags: async () => {
        client.onRead?.();
        return [];
      },
      setFlag: async (key: FeatureFlagKey, enabled: boolean) => ({
        key,
        label: key,
        description: key,
        enabled,
      }),
    } satisfies FeatureFlagAdmin,
    // The storage tools are enabled, so an `ide/*` storage frame reaches its ownership gate.
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  );
  server.allowRequests();
  // daemon.ts: a session acquiring a device cancels the sessionless work admitted on it.
  sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
    executionTracker.cancelSessionlessDeviceUse(deviceId);
    server.liftSessionlessStrokesOn(deviceId);
  });
  // daemon.ts: queue holder strokes on the old device synchronously at unbind.
  sessionManager.onSessionDeviceUnbound((sessionId, deviceId) =>
    server.liftStrokesHeldByOn(sessionId, deviceId),
  );
  // socketServer.start(): a released session's strokes are lifted.
  sessionManager.onSessionRelease((sessionId) => void server.liftStrokesHeldBy(sessionId));

  async function settle(): Promise<void> {
    // Negative assertions include queued no-ops and deliberately pending calls; drain their
    // await chains without depending on real event-loop scheduling.
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
  }

  return {
    sessionManager,
    deviceCalls,
    settle,
    isDeviceWorkQueued: (deviceId) => server.hasForwardTail(`device:${deviceId}`),
    connect() {
      const socket = new FakeSocket();
      sockets.push(socket);
      server.connect(socket);
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
      await server.settleActiveRequestHandlers();
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
