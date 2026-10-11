import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { spyOn } from "bun:test";
import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice } from "../../../src/models";
import { executionTracker } from "../../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createFakeDaemonState, createFakeDeviceManager } from "../helpers/inputSocketHarness";

/**
 * Rig for the direct-socket-frame hunt (hunt/socket-frames-4).
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
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
  liftSessionlessStrokesOn(deviceId: string): void;
}

export interface DeviceClientFake {
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
    const called = (what: string) => deviceCalls.push(`${device.deviceId}:${what}`);
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
        return { success: true };
      },
      setPreference: async (...args: unknown[]) => {
        called("setPreference");
        await client.setPreference?.(...args);
      },
      removePreference: async () => {
        called("removePreference");
      },
      clearPreferenceStore: async (...args: unknown[]) => {
        called("clearPreferenceStore");
        await client.clearPreferenceStore?.(...args);
      },
    } as unknown as AndroidCtrlProxyClient;
  });

  const fakePool = createFakeDaemonState().getDevicePool();
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => fakePool,
    } as unknown as DaemonStateAccess,
    new FakeTimer(),
    null,
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
  // socketServer.start(): a released session's strokes are lifted.
  sessionManager.onSessionRelease((sessionId) => void internals.liftStrokesHeldBy(sessionId));

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return {
    sessionManager,
    deviceCalls,
    settle,
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
