import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  { method: "ide/removeKeyValue", params: { ...KEY_VALUE, key: "k" }, sends: "removePreference" },
  { method: "ide/clearKeyValueFile", params: { ...KEY_VALUE }, sends: "clearPreferenceStore" },
  { method: "ide/updateService", params: {}, sends: "updateService" },
];
const INPUT_FRAMES = FRAMES.filter((frame) => frame.method.startsWith("input/"));

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
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const idleClock = () => {
    const session = sessionManager.getSession(SESSION);
    return { lastUsedAt: session?.lastUsedAt, expiresAt: session?.expiresAt };
  };

  const record = (call: string) => async (): Promise<{ success: true }> => {
    sent.push(call);
    return { success: true };
  };

  beforeEach(async () => {
    sent = [];
    discoveryTakesMs = 0;
    screenGeometry = null;
    toolsEnabled = true;
    timer = new FakeTimer();
    serverTimer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // The tracker judges on the session clock and reports call ends, as in `daemon.ts`.
    executionTracker.setSessionClockOffsetProvider(() => sessionManager.sessionNow() - Date.now());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    await heartbeat(true);

    PlatformDeviceManagerFactory.setInstance({
      getBootedDevicesDetailed: async () => {
        serverTimer.advanceTime(discoveryTakesMs);
        return { devices: [androidDevice], succeededPlatforms: new Set(["android", "ios"]) };
      },
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => screenGeometry,
          requestTapCoordinates: record("tap"),
          requestSwipe: record("swipe"),
          requestGestureStart: record("gestureStart"),
          requestGestureMove: record("gestureMove"),
          requestGestureEnd: record("gestureEnd"),
          requestSetText: record("setText"),
          setPreference: record("setPreference"),
          removePreference: record("removePreference"),
          clearPreferenceStore: record("clearPreferenceStore"),
        }) as unknown as AndroidCtrlProxyClient,
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
    const fakePool = createFakeDaemonState().getDevicePool();
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
        sessionToolSelectionService: {
          isEnabled: async () => toolsEnabled,
          setEnabled: async () => {},
        },
      },
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
  });

  afterEach(async () => {
    // Closing the socket lifts any stroke it still owns, through the fake client: settle that
    // before the fakes are restored.
    socket.destroy();
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...internals.activeRequestHandlers]);
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    spyOn(PressButton.prototype, "press").mockRestore();
    spyOn(InputKey.prototype, "press").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
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
