import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import type { StorageWriteOptions } from "../../src/features/storage/storageTypes";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { drainUntil, drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { InputKey } from "../../src/features/action/InputKey";
import { PressButton } from "../../src/features/action/PressButton";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { androidDevice, createFakeDaemonState } from "./helpers/inputSocketHarness";

/**
 * A control frame counts as use of the holder's session only when it actually runs (#10698,
 * #10824; the socket twin of #11558 item 2). The holder's `input/*` or `ide/*` frame is tracked as
 * control in flight from its admission on, so the session is never released under it, but it
 * restarts the idle window only once it passed every pre-dispatch check and is about to act on the
 * device (#11596). A frame refused for a stale `frameContext`, spent budget, out-of-bounds
 * coordinates or an invalid value sends nothing, so a pane repeating it cannot hold the device.
 *
 * Real SessionManager, execution tracker and socket server on a FakeTimer, wired as `daemon.ts`
 * wires them; only the device clients are fakes.
 */

class FakeSocket extends EventEmitter {
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
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  runIdeKeyValueMutation(
    platform: "android",
    device: typeof androidDevice,
    appId: string,
    fileName: string,
    mutation: {
      dispatching: () => void;
      viaSdk: (onDispatch: () => void) => Promise<void>;
      viaDirectFile: () => Promise<void>;
    },
  ): Promise<{ usedDirectFileFallback: boolean }>;
  handleIdeSocketRequest(request: DaemonRequest): Promise<unknown>;
}

const SESSION = "idle-input-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 120_000;

/** Every `input/*` and device-mutating `ide/*` control frame, with params that run. */
const KEY_VALUE = { appId: "com.example", fileName: "prefs" };
const FRAMES: ReadonlyArray<{
  method: string;
  params: Record<string, unknown>;
  /** The device call a frame that runs makes. */
  sends: string;
  frameContext?: boolean;
}> = [
  { method: "input/tap", params: { x: 1, y: 2 }, sends: "tap", frameContext: true },
  {
    method: "input/swipe",
    params: { startX: 1, startY: 2, endX: 3, endY: 4 },
    sends: "swipe",
    frameContext: true,
  },
  { method: "input/gestureStart", params: { gestureId: "g1", x: 1, y: 2 }, sends: "gestureStart" },
  { method: "input/gestureMove", params: { gestureId: "g1", x: 1, y: 2 }, sends: "gestureMove" },
  { method: "input/gestureEnd", params: { gestureId: "g1", x: 1, y: 2 }, sends: "gestureEnd" },
  { method: "input/typeText", params: { text: "hi" }, sends: "setText", frameContext: true },
  {
    method: "input/pressButton",
    params: { button: "home" },
    sends: "pressButton",
    frameContext: true,
  },
  { method: "input/key", params: { key: "enter" }, sends: "key", frameContext: true },
  {
    method: "ide/setKeyValue",
    params: { ...KEY_VALUE, key: "k", value: "v", type: "STRING" },
    sends: "setPreference",
  },
  {
    method: "ide/setKeyValue",
    params: { ...KEY_VALUE, key: "k", value: null, type: "STRING" },
    sends: "removePreference",
  },
  { method: "ide/removeKeyValue", params: { ...KEY_VALUE, key: "k" }, sends: "removePreference" },
  { method: "ide/clearKeyValueFile", params: { ...KEY_VALUE }, sends: "clearPreferenceStore" },
  { method: "ide/updateService", params: {}, sends: "updateService" },
];
const INPUT_FRAMES = FRAMES.filter((frame) => frame.method.startsWith("input/"));
const IDE_FRAMES = FRAMES.filter((frame) => frame.method.startsWith("ide/"));

describe("a holder's control frame refused before it reaches the device", () => {
  let timer: FakeTimer;
  let serverTimer: FakeTimer;
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  let sent: string[];
  let unsubscribeActivity: () => void;
  /** Server-clock time a discovery sweep takes; a frame's budget runs on that clock. */
  let discoveryTakesMs: number;
  let screenGeometry: { pixelWidth: number; pixelHeight: number } | null;
  let toolsEnabled: boolean;
  let beforeDeviceWork: (() => void) | undefined;
  let deviceWork: ((onDispatch?: () => void) => Promise<{ success: true }>) | undefined;
  let duringOwnershipGate: (() => void) | undefined;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  function stateFor(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  async function heartbeat(claim = false): Promise<void> {
    const response = await handleDaemonRequest(
      {
        id: "hb",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: OWNER_TOKEN,
          ...(claim ? { claimLivenessOwnership: true } : {}),
        },
      },
      stateFor(),
    );
    expect(response.success).toBe(true);
  }

  async function send(
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<DaemonResponse | undefined> {
    socket.send({
      id,
      type: "mcp_request",
      method,
      params: { platform: "android", deviceId: DEVICE, sessionUuid: SESSION, ...params },
    });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const idleClock = () => {
    const session = sessionManager.getSession(SESSION);
    return { lastUsedAt: session?.lastUsedAt, expiresAt: session?.expiresAt };
  };

  const record =
    (call: string, hookIndex?: number) =>
    async (...args: unknown[]): Promise<{ success: true }> => {
      const hook = hookIndex === undefined ? undefined : args[hookIndex];
      const onDispatch =
        typeof hook === "function"
          ? (hook as () => void)
          : (hook as StorageWriteOptions | undefined)?.onDispatch;
      if (deviceWork) {
        return deviceWork(onDispatch);
      }
      onDispatch?.();
      sent.push(call);
      return { success: true };
    };

  beforeEach(async () => {
    sent = [];
    discoveryTakesMs = 0;
    screenGeometry = null;
    toolsEnabled = true;
    beforeDeviceWork = undefined;
    duringOwnershipGate = undefined;
    deviceWork = undefined;
    timer = new FakeTimer();
    serverTimer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // The tracker judges on the session clock and reports call ends, as in `daemon.ts`.
    executionTracker.setSessionClockOffsetProvider(
      (wallNowMs = Date.now()) => sessionManager.sessionNow() - wallNowMs,
    );
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await heartbeat(true);

    PlatformDeviceManagerFactory.setInstance({
      getBootedDevicesDetailed: async () => {
        serverTimer.advanceTime(discoveryTakesMs);
        return {
          devices: [androidDevice, { ...androidDevice, deviceId: "idle-ios", platform: "ios" }],
          succeededPlatforms: new Set(["android", "ios"]),
        };
      },
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      // After resolveKeyValueMutationClient's abort check, before the mutation's own check.
      beforeDeviceWork?.();
      return {
        getScreenScaleMetadata: () => screenGeometry,
        requestTapCoordinates: record("tap", 6),
        requestSwipe: record("swipe", 8),
        requestGestureStart: record("gestureStart"),
        requestGestureMove: record("gestureMove"),
        requestGestureEnd: record("gestureEnd"),
        requestSetText: record("setText"),
        setPreference: record("setPreference", 5),
        removePreference: record("removePreference", 3),
        clearPreferenceStore: record("clearPreferenceStore", 2),
      } as unknown as AndroidCtrlProxyClient;
    });
    spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 100, pixelHeight: 100 }),
          requestTapCoordinates: record("tap", 7),
          requestDrag: record("swipe", 10),
          setPreference: record("setPreference", 5),
          removePreference: record("removePreference", 3),
          clearPreferenceStore: record("clearPreferenceStore", 2),
        }) as unknown as IOSCtrlProxyClient,
    );
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(
      () =>
        ({
          ensureCompatibleVersion: async () => {
            sent.push("updateService");
            return { status: "compatible" };
          },
        }) as unknown as AndroidCtrlProxyManager,
    );
    spyOn(PressButton.prototype, "press").mockImplementation(
      record("pressButton") as unknown as PressButton["press"],
    );
    spyOn(InputKey.prototype, "press").mockImplementation(
      record("key") as unknown as InputKey["press"],
    );
    const fakePool = {
      ...createFakeDaemonState().getDevicePool(),
      assertNotClaimedByForeignDaemon: async () => {
        duringOwnershipGate?.();
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
      serverTimer,
      null,
      {
        adbClientFactory: new FakeAdbClientFactory(),
        sessionToolSelectionService: {
          isEnabled: async () => toolsEnabled,
          setEnabled: async () => {},
        },
      },
    );
    internals = server as unknown as Internals;
    // Observe the route rejection even when a closed socket suppresses its response.
    spyOn(internals, "handleIdeSocketRequest");
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
  });

  afterEach(async () => {
    // Closing the socket lifts any stroke it still owns, through the fake client: settle that
    // before the fakes are restored.
    socket.destroy();
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    await Promise.all([...internals.activeRequestHandlers]);
    spyOn(internals, "handleIdeSocketRequest").mockRestore();
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(IOSCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    spyOn(PressButton.prototype, "press").mockRestore();
    spyOn(InputKey.prototype, "press").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
  });

  afterAll(() => {
    expect((IOSCtrlProxyClient.getInstance as { mock?: unknown }).mock).toBeUndefined();
    expect((AndroidCtrlProxyClient.getInstance as { mock?: unknown }).mock).toBeUndefined();
  });

  test("control: a tap that runs restarts the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("ran", "input/tap", { x: 1, y: 2 });

    expect(response).toMatchObject({ success: true });
    expect(sent).toEqual(["tap"]);
    expect(idleClock().lastUsedAt).toBe(before.lastUsedAt! + 1_000);
  });

  test("control: a foreign session's tap is refused and leaves the idle window alone", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("foreign", "input/tap", { x: 1, y: 2, sessionUuid: "someone" });

    expect(response).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    expect(idleClock()).toEqual(before);
  });

  test("a tap refused for a stale frameContext does not restart the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("stale", "input/tap", { x: 1, y: 2, frameContext: "frame-1" });

    expect(sent).toEqual([]);
    expect(response?.success).toBe(false);
    expect(response?.error).toContain("frameContext is stale or unavailable");
    expect(idleClock()).toEqual(before);
  });

  test("a key refused for a stale frameContext does not restart the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("stale-key", "input/key", {
      key: "enter",
      frameContext: "frame-1",
    });

    expect(response?.success).toBe(false);
    expect(response?.error).toContain("frameContext is stale or unavailable");
    expect(idleClock()).toEqual(before);
  });

  test("a client repeating a refused frame does not hold the device past the idle window", async () => {
    const releaseAt = idleClock().expiresAt!;
    // The owner stays alive (heartbeats); the only "use" is a frame that is refused every time.
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += 2_000) {
      timer.advanceTime(2_000);
      await heartbeat();
      const response = await send(`stale-${elapsed}`, "input/tap", {
        x: 1,
        y: 2,
        frameContext: "frame-1",
      });
      expect(response?.success).toBe(false);
    }

    expect(sent).toEqual([]);
    expect(idleClock().expiresAt).toBe(releaseAt);
  });

  describe("connection is not session use (#11750)", () => {
    const covered = FRAMES.filter((frame) =>
      [
        "input/tap",
        "input/swipe",
        "ide/setKeyValue",
        "ide/removeKeyValue",
        "ide/clearKeyValueFile",
      ].includes(frame.method),
    );
    for (const platform of ["android", "ios"] as const) {
      const frames = platform === "android" ? covered : [covered[0], covered[1], covered[2]];
      for (const outcome of ["cancel", "close", "failure", "sent"] as const) {
        test.each(frames)(
          `${platform} $method ($sends): ${outcome} while connecting`,
          async (frame) => {
            const deviceId = platform === "android" ? DEVICE : "idle-ios";
            if (platform === "ios") {
              await sessionManager.createSession("ios-holder", deviceId, "ios", IDLE_MS);
            }
            const sessionId = platform === "android" ? SESSION : "ios-holder";
            const clock = () => {
              const session = sessionManager.getSession(sessionId)!;
              return { lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt };
            };
            const before = clock();
            timer.advanceTime(1_000);
            const connecting = Promise.withResolvers<void>();
            let parked = false;
            let hooks = 0;
            deviceWork = async (onDispatch) => {
              parked = true;
              await connecting.promise;
              if (outcome !== "sent") {
                throw new Error("failed to connect");
              }
              if (typeof onDispatch === "function") {
                onDispatch();
                hooks++;
              }
              sent.push(frame.sends);
              return { success: true };
            };
            socket.send({
              id: "connecting",
              type: "mcp_request",
              method: frame.method,
              params: { ...frame.params, platform, deviceId, sessionUuid: sessionId },
            });
            await drainUntil(() => parked, { description: "fake client connecting" });
            if (outcome === "cancel") {
              socket.send({
                id: "cancel-connect",
                type: "daemon_request",
                method: "daemon/cancelRequest",
                params: { requestId: "connecting" },
              });
              await drainUntil(() => socket.responses.some((r) => r.id === "cancel-connect"), {
                description: "cancel acknowledged",
              });
              expect(socket.responses.find((r) => r.id === "cancel-connect")?.result).toMatchObject(
                { cancelled: true },
              );
            } else if (outcome === "close") {
              socket.destroy();
            }
            connecting.resolve();
            await Promise.all([...internals.activeRequestHandlers]);
            if (outcome === "sent") {
              expect(socket.responses.find((r) => r.id === "connecting")?.success).toBe(true);
              expect(sent).toEqual([frame.sends]);
              expect(hooks).toBe(1);
              expect(clock()).toEqual({
                lastUsedAt: before.lastUsedAt + 1_000,
                expiresAt: before.expiresAt + 1_000,
              });
            } else {
              expect(sent).toEqual([]);
              expect(hooks).toBe(0);
              expect(clock()).toEqual(before);
            }
          },
        );
      }
    }
  });

  describe("direct-file fallback dispatch count", () => {
    for (const sdkSent of [false, true]) {
      for (const cancelled of [false, true]) {
        test(`SDK sent=${sdkSent}, fallback cancelled=${cancelled}`, async () => {
          let stamps = 0;
          let directWrites = 0;
          const call = new AbortController();
          const pending = runWithAbortSignal(call.signal, () =>
            internals.runIdeKeyValueMutation("android", androidDevice, "com.example", "prefs", {
              dispatching: () => stamps++,
              viaSdk: async (onDispatch) => {
                if (sdkSent) {
                  onDispatch?.();
                }
                if (cancelled) {
                  call.abort(new Error("cancel before fallback"));
                }
                throw new Error("SharedPreferences inspection is disabled");
              },
              viaDirectFile: async () => {
                directWrites++;
              },
            }),
          );
          if (cancelled) {
            await expect(pending).rejects.toThrow("cancel before fallback");
          } else {
            expect(await pending).toEqual({ usedDirectFileFallback: true, resolution: undefined });
          }
          expect(directWrites).toBe(cancelled ? 0 : 1);
          expect(stamps).toBe(cancelled ? Number(sdkSent) : 1);
        });
      }
    }
  });

  describe("every control frame", () => {
    /** Send `frame` from the holder with `overrides`; it must be refused and send nothing. */
    async function expectRefusedWithoutUse(
      frame: (typeof FRAMES)[number],
      overrides: Record<string, unknown>,
      errorContains?: string,
    ): Promise<void> {
      const before = idleClock();
      timer.advanceTime(1_000);

      const response = await send("refused", frame.method, { ...frame.params, ...overrides });

      expect(response?.success).toBe(false);
      if (errorContains) {
        expect(response?.error).toContain(errorContains);
      }
      expect(sent).toEqual([]);
      expect(idleClock()).toEqual(before);
    }

    test.each(FRAMES)("control: $method that runs restarts the idle window", async (frame) => {
      const before = idleClock();
      timer.advanceTime(1_000);

      const response = await send("ran", frame.method, frame.params);

      expect(response).toMatchObject({ success: true });
      expect(sent).toEqual([frame.sends]);
      expect(idleClock().lastUsedAt).toBe(before.lastUsedAt! + 1_000);
    });

    for (const interruption of ["cancel", "close"] as const) {
      test.each(IDE_FRAMES)(
        `$method ($sends) ${interruption} before device work leaves the idle window alone`,
        async (frame) => {
          const before = idleClock();
          timer.advanceTime(1_000);
          let interrupted = false;
          const interrupt = () => {
            interrupted = true;
            if (interruption === "close") {
              socket.destroy();
            } else {
              socket.send({
                id: "cancel-cut",
                type: "daemon_request",
                method: "daemon/cancelRequest",
                params: { requestId: "cut" },
              });
            }
          };
          if (frame.method === "ide/updateService") {
            duringOwnershipGate = interrupt;
          } else {
            beforeDeviceWork = interrupt;
          }

          await send("cut", frame.method, frame.params);

          expect(interrupted).toBe(true);
          if (interruption === "cancel") {
            expect(socket.responses.find((response) => response.id === "cancel-cut")).toMatchObject(
              {
                success: true,
                result: { cancelled: true },
              },
            );
            expect(socket.responses.find((response) => response.id === "cut")).toMatchObject({
              success: false,
            });
          }
          const route = spyOn(internals, "handleIdeSocketRequest").mock.results[0];
          expect(route?.type).toBe("return");
          await expect(route?.value).rejects.toThrow();
          expect(sent).toEqual([]);
          expect(idleClock()).toEqual(before);
        },
      );
    }

    test.each(FRAMES)("$method from a session that does not hold the device", async (frame) => {
      await expectRefusedWithoutUse(frame, { sessionUuid: "someone" });
    });

    test.each(FRAMES)("$method naming no session", async (frame) => {
      await expectRefusedWithoutUse(frame, { sessionUuid: undefined });
    });

    test.each(FRAMES)("$method on a device discovery does not report", async (frame) => {
      await expectRefusedWithoutUse(frame, { deviceId: "emulator-9999" });
    });

    test.each(FRAMES)("$method for an unsupported platform", async (frame) => {
      await expectRefusedWithoutUse(frame, { platform: "windows" });
    });

    test.each(FRAMES.filter((frame) => frame.frameContext))(
      "$method with a stale frameContext",
      async (frame) => {
        await expectRefusedWithoutUse(
          frame,
          { frameContext: "frame-1" },
          "frameContext is stale or unavailable",
        );
      },
    );

    test.each(INPUT_FRAMES)("$method whose budget was spent before dispatch", async (frame) => {
      discoveryTakesMs = 24 * 60 * 60 * 1_000;

      await expectRefusedWithoutUse(frame, {});
    });

    test("input/tap outside the known screen bounds", async () => {
      screenGeometry = { pixelWidth: 100, pixelHeight: 100 };

      await expectRefusedWithoutUse(FRAMES[0], { x: 500, y: 2 }, "outside device canonical pixel");
    });

    test("ide/setKeyValue with a type that cannot be written", async () => {
      const setKeyValue = FRAMES.find((frame) => frame.method === "ide/setKeyValue")!;

      await expectRefusedWithoutUse(setKeyValue, { type: "UNKNOWN" }, "UNKNOWN type is read-only");
    });

    test.each(FRAMES.filter((frame) => frame.method.includes("KeyValue")))(
      "$method while its tool is disabled",
      async (frame) => {
        toolsEnabled = false;

        await expectRefusedWithoutUse(frame, {});
      },
    );
  });
});
