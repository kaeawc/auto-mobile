import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonResponse } from "../../src/daemon/types";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { drainUntil, drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { InputKey } from "../../src/features/action/InputKey";
import { PressButton } from "../../src/features/action/PressButton";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ImeAction } from "../../src/models/ImeAction";
import type { ScreenScaleMetadata } from "../../src/models/ScreenScaleMetadata";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";
import { createIosTestClient } from "../helpers/iosCtrlProxyClientSpies";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { androidDevice, createFakeDaemonState } from "./helpers/inputSocketHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

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

/** Discovery that takes server-clock time, as a slow sweep does. */
class TimedDeviceManager extends FakeDeviceManager {
  constructor(
    private readonly clock: FakeTimer,
    private readonly takesMs: () => number,
  ) {
    super([], [androidDevice, { ...androidDevice, deviceId: "idle-ios", platform: "ios" }]);
  }

  override async getBootedDevicesDetailed(
    ...args: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>
  ): Promise<BootedDeviceDiscovery> {
    this.clock.advanceTime(this.takesMs());
    return super.getBootedDevicesDetailed(...args);
  }
}

const SESSION = "idle-input-session";
const OWNER_TOKEN = "harness-a";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 120_000;

/** Every `input/*` and device-mutating `ide/*` control frame, with params that run. */
const KEY_VALUE = { appId: "com.example", fileName: "prefs" };
const FRAMES: Array<{
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
  let internals: UnixSocketServerHarness;
  let sent: string[];
  let unsubscribeActivity: () => void;
  /** Server-clock time a discovery sweep takes; a frame's budget runs on that clock. */
  let discoveryTakesMs: number;
  let screenGeometry: ScreenScaleMetadata | null;
  let toolsEnabled: boolean;
  let beforeDeviceWork: (() => void) | undefined;
  let deviceWork:
    | ((onDispatch?: () => void) => Promise<{ success: boolean; error?: string }>)
    | undefined;
  let duringOwnershipGate: (() => void) | undefined;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  function stateFor(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async () => {},
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
    await Promise.all([...internals.state.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  const idleClock = () => {
    const session = sessionManager.getSession(SESSION);
    return { lastUsedAt: session?.lastUsedAt, expiresAt: session?.expiresAt };
  };

  /** The dispatch callback a device call receives, either directly or inside its write options. */
  const dispatchHook = (hook: unknown): (() => void) | undefined => {
    if (typeof hook === "function") {
      return () => {
        hook();
      };
    }
    if (typeof hook === "object" && hook !== null && "onDispatch" in hook) {
      const { onDispatch } = hook;
      if (typeof onDispatch === "function") {
        return () => {
          onDispatch();
        };
      }
    }
    return undefined;
  };

  /** Run the device call a test double stands for, honouring `deviceWork` and the dispatch hook. */
  const run =
    (call: string, hookIndex?: number) =>
    async (...args: unknown[]): Promise<{ success: boolean; error?: string }> => {
      const onDispatch = dispatchHook(hookIndex === undefined ? undefined : args[hookIndex]);
      if (deviceWork) {
        return deviceWork(onDispatch);
      }
      onDispatch?.();
      sent.push(call);
      return { success: true };
    };

  /** A request method whose result carries the elapsed time. */
  const record =
    (call: string, hookIndex?: number) =>
    async (...args: unknown[]) => ({ ...(await run(call, hookIndex)(...args)), totalTimeMs: 0 });

  /** An IME action request, whose result names the action. */
  const recordIme =
    (hookIndex: number) =>
    async (action: ImeAction, ...rest: unknown[]) => ({
      ...(await run("ime", hookIndex)(action, ...rest)),
      action,
      totalTimeMs: 0,
    });

  /** A storage write: it reports nothing, but still dispatches. */
  const recordWrite =
    (call: string, hookIndex: number) =>
    async (...args: unknown[]): Promise<undefined> => {
      await run(call, hookIndex)(...args);
      return undefined;
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
    await sessionManager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    await heartbeat(true);

    PlatformDeviceManagerFactory.setInstance(
      new TimedDeviceManager(serverTimer, () => discoveryTakesMs),
    );
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      // After resolveKeyValueMutationClient's abort check, before the mutation's own check.
      beforeDeviceWork?.();
      return createAndroidTestClient(androidDevice, {
        getScreenScaleMetadata: () => screenGeometry,
        requestTapCoordinates: record("tap", 0),
        requestSwipe: record("swipe", 0),
        requestGestureStart: record("gestureStart"),
        requestGestureMove: record("gestureMove"),
        requestGestureEnd: record("gestureEnd"),
        requestSetText: record("setText", 1),
        requestImeAction: recordIme(4),
        setPreference: recordWrite("setPreference", 5),
        removePreference: recordWrite("removePreference", 3),
        clearPreferenceStore: recordWrite("clearPreferenceStore", 2),
      });
    });
    spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation((device) =>
      createIosTestClient(device, {
        getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 100, pixelHeight: 100 }),
        requestTapCoordinates: record("tap", 0),
        requestDrag: record("swipe", 0),
        requestSetText: record("setText", 1),
        requestAppendText: record("appendText", 4),
        requestImeAction: recordIme(4),
        setPreference: recordWrite("setPreference", 5),
        removePreference: recordWrite("removePreference", 3),
        clearPreferenceStore: recordWrite("clearPreferenceStore", 2),
      }),
    );
    const proxyManager = AndroidCtrlProxyManager.createForTestingWithDeps(
      androidDevice,
      new FakeAdbExecutor(),
    );
    spyOn(proxyManager, "ensureCompatibleVersion").mockImplementation(async () => {
      sent.push("updateService");
      return { status: "compatible" };
    });
    spyOn(AndroidCtrlProxyManager, "getInstance").mockImplementation(() => proxyManager);
    spyOn(PressButton.prototype, "press").mockImplementation(async (button, ...rest) => ({
      ...(await run("pressButton", 4)(button, ...rest)),
      button,
      keyCode: 3,
    }));
    spyOn(InputKey.prototype, "press").mockImplementation(async (key, ...rest) => ({
      ...(await run("key", 4)(key, ...rest)),
      key,
      keyCode: "KEYCODE_ENTER",
    }));
    const fakePool = {
      ...createFakeDaemonState().getDevicePool(),
      assertNotClaimedByForeignDaemon: async () => {
        duringOwnershipGate?.();
      },
    };
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => fakePool,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    const server = createHarnessServer(
      "unused",
      state,
      serverTimer,
      null,
      {
        sessionToolSelectionService: {
          isEnabled: async () => toolsEnabled,
          setEnabled: async () => {},
        },
      },
      undefined,
      undefined,
      new FakeAdbClientFactory(),
    );
    server.appendTextFactory = () => ({
      appendText: async (...args) => ({
        ...(await run("appendText", 4)(...args)),
        charsSent: args[0].length,
      }),
    });
    internals = server;
    // Observe the route rejection even when a closed socket suppresses its response.
    spyOn(internals, "handleIdeSocketRequest");
    internals.allowRequests();
    socket = new FakeSocket();
    internals.connect(socket);
  });

  afterEach(async () => {
    // Closing the socket lifts any stroke it still owns, through the fake client: settle that
    // before the fakes are restored.
    socket.destroy();
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    await Promise.all([...internals.state.activeRequestHandlers]);
    spyOn(internals, "handleIdeSocketRequest").mockRestore();
    spyOn(executionTracker, "markSessionAdmitted").mockRestore();
    unsubscribeActivity();
    executionTracker.setSessionClockOffsetProvider(() => 0);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    spyOn(IOSCtrlProxyClient, "getInstance").mockRestore();
    spyOn(AndroidCtrlProxyManager, "getInstance").mockRestore();
    spyOn(PressButton.prototype, "press").mockRestore();
    spyOn(InputKey.prototype, "press").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    expect(AndroidCtrlProxyClient.getExistingInstance(DEVICE)).toBeNull();
    expect(IOSCtrlProxyClient.getExistingInstance("idle-ios")).toBeNull();
  });

  afterAll(() => {
    expect("mock" in IOSCtrlProxyClient.getInstance).toBe(false);
    expect("mock" in AndroidCtrlProxyClient.getInstance).toBe(false);
  });

  test("control: a tap that runs restarts the idle window", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);

    const response = await send("ran", "input/tap", { x: 1, y: 2 });

    expect(response).toMatchObject({ success: true });
    expect(sent).toEqual(["tap"]);
    expect(idleClock().lastUsedAt).toBe(before.lastUsedAt! + 1_000);
  });

  test("input/typeText dispatched device failure marks session use exactly once (#11919)", async () => {
    const before = idleClock();
    timer.advanceTime(1_000);
    const mark = spyOn(executionTracker, "markSessionAdmitted");
    deviceWork = async (onDispatch) => {
      onDispatch?.();
      sent.push("setText");
      return { success: false, error: "No focused editable node found" };
    };

    const response = await send("device-failure", "input/typeText", { text: "hello" });

    expect(response).toMatchObject({ success: false, error: "No focused editable node found" });
    expect(sent).toEqual(["setText"]);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(idleClock()).toEqual({
      lastUsedAt: before.lastUsedAt! + 1_000,
      expiresAt: before.expiresAt! + 1_000,
    });
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

  test.each(["client cancel", "session release"])(
    "post-dispatch text %s retains the holder's idle stamp",
    async (abort) => {
      const before = idleClock();
      const reply = Promise.withResolvers<{ success: true }>();
      let dispatched = false;
      const mark = spyOn(executionTracker, "markSessionAdmitted");
      const releaseAnswer = spyOn(internals, "answeringSessionRelease");
      deviceWork = async (onDispatch) => {
        onDispatch?.();
        dispatched = true;
        return reply.promise;
      };
      timer.advanceTime(1_000);
      socket.send({
        id: "typing",
        type: "mcp_request",
        method: "input/typeText",
        params: { platform: "android", deviceId: DEVICE, sessionUuid: SESSION, text: "abc" },
      });
      await drainUntil(() => dispatched, { description: "text dispatched" });
      const stamped = {
        lastUsedAt: before.lastUsedAt! + 1_000,
        expiresAt: before.expiresAt! + 1_000,
      };
      expect(idleClock()).toEqual(before);
      expect(mark).toHaveBeenCalledTimes(1);
      const release = new SessionReleasedDuringCallError(SESSION, "explicit-release");
      const releaseMessage = release.message;
      if (abort === "session release") {
        expect(await executionTracker.cancelDeviceSessionExecutions(SESSION, release)).toBe(1);
      } else {
        socket.send({
          id: "cancel-typing",
          type: "daemon_request",
          method: "daemon/cancelRequest",
          params: { requestId: "typing" },
        });
        await drainUntil(() => socket.responses.some((r) => r.id === "cancel-typing"), {
          description: "cancel ack",
        });
      }
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
      expect(socket.responses.some((r) => r.id === "typing")).toBe(false);
      expect(idleClock()).toEqual(before);
      expect(mark).toHaveBeenCalledTimes(1);
      expect(executionTracker.getActiveExecutionCount()).toBe(1);
      reply.resolve({ success: true });
      await Promise.all([...internals.state.activeRequestHandlers]);
      const response = socket.responses.find((r) => r.id === "typing");
      expect(response).toMatchObject(
        abort === "session release"
          ? {
              success: false,
              error: expect.stringContaining(
                "the text request had been dispatched; its outcome is indeterminate",
              ),
              code: "session_ownership_lost",
              retryable: false,
              nextAction: "acquire_new_session",
              details: { sessionUuid: SESSION, reason: "explicit-release" },
            }
          : { success: false, error: expect.stringContaining("outcome is indeterminate") },
      );
      expect(Object.keys(response!).sort()).toEqual(
        abort === "session release"
          ? ["id", "type", "success", "error", "code", "retryable", "nextAction", "details"].sort()
          : ["id", "type", "success", "error", "requestFailureCause"].sort(),
      );
      if (abort === "session release") {
        const answer = releaseAnswer.mock.results.at(-1)!;
        expect(answer.type).toBe("return");
        if (answer.type === "return") {
          await expect(answer.value).rejects.toBeInstanceOf(SessionReleasedDuringCallError);
        }
        expect(release.message).toBe(releaseMessage);
        await expect(
          internals.answeringSessionRelease({ cancelReason: release }, async () => {
            throw new Error("tap aborted");
          }),
        ).rejects.toBe(release);
      }
      releaseAnswer.mockRestore();
      expect(idleClock()).toEqual(stamped);
      expect(mark).toHaveBeenCalledTimes(1);
      mark.mockRestore();
      expect(executionTracker.getActiveExecutionCount()).toBe(0);
    },
  );

  test.each(["client cancel", "session release", "socket close"] as const)(
    "pre-dispatch append resolution %s answers before resolution settles without an idle stamp",
    async (abort) => {
      const before = idleClock();
      const target = Promise.withResolvers<typeof androidDevice>();
      const resolve = internals.resolveInputTargetDevice.bind(internals);
      let calls = 0;
      let resolving = false;
      const resolution = spyOn(internals, "resolveInputTargetDevice").mockImplementation(
        (...args) => {
          if (++calls === 2) {
            resolving = true;
            return target.promise;
          }
          return resolve(...args);
        },
      );
      const releaseAnswer = spyOn(internals, "answeringSessionRelease");
      const mark = spyOn(executionTracker, "markSessionAdmitted");
      socket.send({
        id: "preparing",
        type: "mcp_request",
        method: "input/typeText",
        params: {
          platform: "android",
          deviceId: DEVICE,
          sessionUuid: SESSION,
          text: "abc",
          mode: "append",
        },
      });
      await drainUntil(() => resolving, { description: "tracked append target resolution" });
      if (abort === "session release") {
        expect(
          await executionTracker.cancelDeviceSessionExecutions(
            SESSION,
            new SessionReleasedDuringCallError(SESSION, "explicit-release"),
          ),
        ).toBe(1);
      } else if (abort === "socket close") {
        socket.destroy();
      } else {
        socket.send({
          id: "cancel-preparing",
          type: "daemon_request",
          method: "daemon/cancelRequest",
          params: { requestId: "preparing" },
        });
      }
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
      try {
        if (abort !== "socket close") {
          expect(socket.responses.find((r) => r.id === "preparing")).toMatchObject({
            success: false,
            ...(abort === "session release"
              ? {
                  code: "session_ownership_lost",
                  details: { sessionUuid: SESSION, reason: "explicit-release" },
                }
              : {}),
          });
        }
        expect(executionTracker.getActiveExecutionCount()).toBe(0);
        expect(sent).toEqual([]);
        expect(mark).not.toHaveBeenCalled();
        expect(idleClock()).toEqual(before);
      } finally {
        target.resolve(androidDevice);
        await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
        await Promise.all([...internals.state.activeRequestHandlers]);
        resolution.mockRestore();
        releaseAnswer.mockRestore();
        mark.mockRestore();
      }
      expect(sent).toEqual([]);
      expect(idleClock()).toEqual(before);
    },
  );

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
        "input/key",
        "input/pressButton",
        "input/typeText",
        "ide/setKeyValue",
        "ide/removeKeyValue",
        "ide/clearKeyValueFile",
      ].includes(frame.method),
    );
    for (const platform of ["android", "ios"] as const) {
      const frames = [
        ...covered.filter((frame) => platform === "android" || frame.method !== "input/key"),
        { method: "input/typeText", params: { text: "abc", mode: "append" }, sends: "appendText" },
      ];
      for (const outcome of ["cancel", "close", "failure", "sent"] as const) {
        test.each(frames)(
          `${platform} $method ($sends): ${outcome} while connecting`,
          async (frame) => {
            const deviceId = platform === "android" ? DEVICE : "idle-ios";
            if (platform === "ios") {
              await sessionManager.createSession("ios-holder", deviceId, "ios", {
                timeoutMs: IDLE_MS,
              });
            }
            const sessionId = platform === "android" ? SESSION : "ios-holder";
            const clock = () => {
              const session = sessionManager.getSession(sessionId)!;
              return { lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt };
            };
            const before = clock();
            timer.advanceTime(1_000);
            const mark = spyOn(executionTracker, "markSessionAdmitted");
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
            const clockWhileConnecting = clock();
            const marksWhileConnecting = mark.mock.calls.length;
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
            await Promise.all([...internals.state.activeRequestHandlers]);
            expect(clockWhileConnecting).toEqual(before);
            expect(marksWhileConnecting).toBe(0);
            if (outcome === "sent") {
              expect(socket.responses.find((r) => r.id === "connecting")?.success).toBe(true);
              expect(sent).toEqual([frame.sends]);
              expect(hooks).toBe(1);
              expect(mark).toHaveBeenCalledTimes(1);
              expect(clock()).toEqual({
                lastUsedAt: before.lastUsedAt + 1_000,
                expiresAt: before.expiresAt + 1_000,
              });
            } else {
              expect(sent).toEqual([]);
              expect(hooks).toBe(0);
              expect(clock()).toEqual(before);
            }
            mark.mockRestore();
          },
        );
      }
    }
  });

  test("gestureStart stamps before stroke admission is captured", async () => {
    const mark = spyOn(executionTracker, "markSessionAdmitted");
    const capture = internals.captureStrokeAdmission.bind(internals);
    const admission = spyOn(internals, "captureStrokeAdmission").mockImplementation((...args) => {
      expect(mark).toHaveBeenCalledTimes(1);
      const result = capture(...args);
      expect(result).toMatchObject({ holderSessionId: SESSION });
      return result;
    });
    try {
      expect(
        (await send("gesture-pin", "input/gestureStart", { gestureId: "pin", x: 1, y: 2 }))
          ?.success,
      ).toBe(true);
      expect(admission).toHaveBeenCalledTimes(1);
    } finally {
      admission.mockRestore();
      mark.mockRestore();
    }
  });

  for (const platform of ["android", "ios"] as const) {
    for (const append of [false, true]) {
      test(`${platform} typeText append=${append} with submit marks only its first send`, async () => {
        const deviceId = platform === "android" ? DEVICE : "idle-ios";
        const sessionId = platform === "android" ? SESSION : "ios-holder";
        if (platform === "ios") {
          await sessionManager.createSession(sessionId, deviceId, "ios", { timeoutMs: IDLE_MS });
        }
        const mark = spyOn(executionTracker, "markSessionAdmitted");
        try {
          expect(
            (
              await send("submit", "input/typeText", {
                text: "abc",
                mode: append ? "append" : undefined,
                submit: true,
                platform,
                deviceId,
                sessionUuid: sessionId,
              })
            )?.success,
          ).toBe(true);
          expect(sent).toEqual([append ? "appendText" : "setText", "ime"]);
          expect(mark).toHaveBeenCalledTimes(1);
        } finally {
          mark.mockRestore();
        }
      });
    }
  }

  describe("direct-file fallback dispatch count", () => {
    for (const sdkSent of [false, true]) {
      for (const cancelled of [false, true]) {
        test(`SDK sent=${sdkSent}, fallback cancelled=${cancelled}`, async () => {
          let stamps = 0;
          let directWrites = 0;
          const call = new AbortController();
          const pending = runWithAbortSignal(call.signal, () =>
            internals.runIdeKeyValueMutation("android", androidDevice, "com.example", "prefs", {
              ideMutation: {
                track: () => {},
                admit: () => {},
                dispatching: () => stamps++,
                socketSessionId: undefined,
                signal: call.signal,
              },
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
      screenGeometry = { nativeScale: 1, pixelWidth: 100, pixelHeight: 100 };

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
