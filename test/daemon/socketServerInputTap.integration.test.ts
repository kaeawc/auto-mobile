import { spyOn } from "bun:test";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  createFakeDaemonState as createDrainDaemonState,
  createFakeSession as createDrainSession,
} from "./helpers/inputSocketHarness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseInputKeyParams,
  parseInputPressButtonParams,
  parseInputTapParams,
  parseInputTypeTextParams,
} from "../../src/daemon/inputRouteParams";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { DAEMON_PREPARE_RESTART_METHOD } from "../../src/daemon/daemonRestartAdmission";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { CtrlProxySyncedHierarchy } from "../../src/features/observe/ios/types";
import type { ScreenScaleMetadata } from "../../src/models/ScreenScaleMetadata";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createAndroidTestClient,
  spyOnAndroidClientInstance,
} from "../helpers/androidCtrlProxyClientSpies";
import { spyOnIosTestClientInstance } from "../helpers/iosCtrlProxyClientSpies";
import {
  androidDevice,
  iosDevice,
  createFakeDeviceManager,
  createFakeSession,
  createFakeDaemonState,
  sendRequest,
  sendRequestAfterConnect,
} from "./helpers/inputSocketHarness";

async function emptySyncedHierarchy(): Promise<CtrlProxySyncedHierarchy> {
  return { hierarchy: { updatedAt: 0, packageName: "", hierarchy: {} } };
}

describe("UnixSocketServer input/tap", () => {
  let socketPath: string;
  let server: UnixSocketServerHarness;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-tap-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    executionTracker.clearDaemonRestartPreparation();
    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    executionTracker.clearDaemonRestartPreparation();
    mock.restore();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    executionTracker.clearDaemonRestartPreparation();
    executionTracker.clearDaemonMaintenancePreparation();
  });

  test("routes Android coordinate taps without forwarding through tools/call", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    const createMcpClient = mock(async () => {
      throw new Error("input/tap should not create an MCP client");
    });
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const response = await sendRequest(
      socketPath,
      "input/tap",
      {
        platform: "android",
        deviceId: "emulator-5554",
        x: 12.5,
        y: 34.25,
        duration: 80,
      },
      1234,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/tap",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      coordinates: { x: 12.5, y: 34.25 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith({
      x: 12.5,
      y: 34.25,
      duration: 80,
      timeoutMs: 1234,
      perf: undefined,
      frameContext: undefined,
      onDispatch: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  // The quarantine used to be enforced only through `assertSessionReadyForAutomation`,
  // which `runTrackedDeviceInput` reaches ONLY when the serial has a bound session —
  // so an idle quarantined emulator still took explicit-device input. Every
  // device-addressed operation now passes `DevicePool.assertDeviceActionable`, with
  // or without a session ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863)
  // review).
  test("refuses a sessionless tap on a serial whose pooled identity is quarantined", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(
      socketPath,
      createFakeDaemonState(new Map(), new Map(), new Set(["emulator-5554"])),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 12.5,
      y: 34.25,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("emulator-5554");
    expect(response.error).toContain("identity is unresolved");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("defers a restart while a sessionless direct tap is in flight", async () => {
    let tapStarted!: () => void;
    const tapEntered = new Promise<void>((resolve) => {
      tapStarted = resolve;
    });
    let releaseTap!: () => void;
    const tapReleased = new Promise<void>((resolve) => {
      releaseTap = resolve;
    });
    const requestTapCoordinates = mock(async () => {
      tapStarted();
      await tapReleased;
      return { success: true, totalTimeMs: 0 };
    });
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const tap = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 12,
      y: 34,
    });
    await tapEntered;
    try {
      const status = await sendRequest(socketPath, "ide/status");
      const restart = await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status.result);
      expect(restart.result).toEqual({ accepted: false, reason: "active_operations" });
    } finally {
      releaseTap();
      await tap;
    }
  });

  test("rejects Android tap coordinates outside known canonical pixel bounds", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 1080, pixelHeight: 2340 }),
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const negative = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: -1,
      y: 100,
    });
    const oversized = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 100,
      y: 2340,
    });

    expect(negative.success).toBe(false);
    expect(negative.error).toContain("x=-1, y=100");
    expect(negative.error).toContain("x: 0..1079, y: 0..2339");
    expect(oversized.success).toBe(false);
    expect(oversized.error).toContain("x=100, y=2340");
    expect(oversized.error).toContain("x: 0..1079, y: 0..2339");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("LEGACY iOS tap: probe SUCCEEDS with no metadata -> pass through unchanged", async () => {
    // The probe returns a hierarchy (success) but it carries no scale metadata: a genuine pre-#4548
    // runner. The control client never got px bounds, so it sends points — pass through, no divide.
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    const fetchHierarchy = mock(emptySyncedHierarchy);
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => null,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: -50,
      y: 999999,
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({ coordinates: { x: -50, y: 999999 } });
    expect(fetchHierarchy).toHaveBeenCalledTimes(1); // it probed to learn the scale first
    expect(requestTapCoordinates).toHaveBeenCalledWith({
      x: -50,
      y: 999999,
      duration: undefined,
      timeoutMs: 30_000,
      perf: undefined,
      frameContext: undefined,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("rejects an Android frameContext without a matching device observation", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 12.5,
      y: 34.25,
      frameContext: "screen-A",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("stale or unavailable");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap: a confirmed-legacy device probes only ONCE across consecutive taps (#4549 D)", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    const fetchHierarchy = mock(emptySyncedHierarchy); // success, no metadata => legacy
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => null,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 20,
      y: 30,
    });
    await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 40,
      y: 50,
    });

    expect(fetchHierarchy).toHaveBeenCalledTimes(1); // cached after the first confirms legacy
    expect(requestTapCoordinates).toHaveBeenCalledTimes(2);
  });

  test("iOS tap: a FAILED probe (no hierarchy) rejects the input instead of assuming legacy (#4549 C)", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    const fetchHierarchy = mock(async () => null); // not connected / timed out -> FAILURE
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => null,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Could not determine iOS screen scale");
    expect(requestTapCoordinates).not.toHaveBeenCalled(); // fail closed, no mis-dispatch
  });

  test("iOS tap: a THROWN probe rejects the input (#4549 C)", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    const fetchHierarchy = mock(async () => {
      throw new Error("ws disconnected");
    });
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => null,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("scale probe failed");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap: the scale probe is charged against the gesture budget (#4549 B)", async () => {
    // The probe consumes 20s of the 30s budget; the gesture must get only the ~10s remainder, not a
    // fresh 30s (which would let probe + gesture run ~2x the declared budget).
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    let scale: ScreenScaleMetadata | null = null;
    const fetchHierarchy = mock(async () => {
      fakeTimer.advanceTime(20_000);
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return emptySyncedHierarchy();
    });
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(true);
    expect(requestTapCoordinates).toHaveBeenCalledWith({
      x: 200,
      y: 300,
      duration: undefined,
      timeoutMs: 10_000,
      perf: undefined,
      frameContext: undefined,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("iOS tap: a probe that consumes the whole budget fails with a timeout, not a full-budget gesture (#4549 B)", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    let scale: ScreenScaleMetadata | null = null;
    const fetchHierarchy = mock(async () => {
      fakeTimer.advanceTime(31_000); // exceeds the 30s budget
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return emptySyncedHierarchy();
    });
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("canonical-pixel iOS tap divides by nativeScale (exact) before dispatch to the points-based runner", async () => {
    // The control client renders a px frame (#4549) and sends the tap in PIXELS; the daemon divides
    // EXACTLY by nativeScale so the XCUITest runner receives (fractional) points and the tap lands
    // at the same physical location. 1169/3 = 389.666..., 2531/3 = 843.666....
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => ({ nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 }),
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 1169,
      y: 2531,
    });

    expect(response.success).toBe(true);
    // The echoed coordinates stay in the client's px space; only the runner dispatch is converted.
    expect(response.result).toMatchObject({ coordinates: { x: 1169, y: 2531 } });
    const [{ x, y }] = requestTapCoordinates.mock.calls[0];
    expect(x).toBeCloseTo(1169 / 3, 10);
    expect(y).toBeCloseTo(2531 / 3, 10);
  });

  test("iOS tap rejects coordinates outside bounds learned by the scale probe", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    let scale: ScreenScaleMetadata | null = null;
    const fetchHierarchy = mock(async () => {
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return emptySyncedHierarchy();
    });
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 1170,
      y: 100,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("x=1170, y=100");
    expect(response.error).toContain("x: 0..1169, y: 0..2531");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap before ANY hierarchy fetches one first, then divides by the learned nativeScale", async () => {
    // Startup window: the control client's first tap arrives before the daemon received any
    // hierarchy, so #4548 receipt-based retention has not run and getScreenScaleMetadata() is null.
    // The daemon fetches a hierarchy (populating the scale via receipt), then converts.
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    let scale: ScreenScaleMetadata | null = null;
    const fetchHierarchy = mock(async () => {
      // Simulate #4548 receipt-based retention populating the scale during the fetch. The probe
      // SUCCEEDS (returns a hierarchy); the scale is now known.
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return emptySyncedHierarchy();
    });
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(true);
    expect(fetchHierarchy).toHaveBeenCalledTimes(1);
    // 600/3 = 200, 900/3 = 300 — NOT dispatched as 600/900 points (which would tap at 1/3 scale).
    expect(requestTapCoordinates).toHaveBeenCalledWith({
      x: 200,
      y: 300,
      duration: undefined,
      timeoutMs: 30_000,
      perf: undefined,
      frameContext: undefined,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("rejects an iOS frameContext without a matching device observation", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<IOSCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnIosTestClientInstance(iosDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 20,
      y: 30,
      frameContext: "7",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("stale or unavailable");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestTapCoordinates = mock(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].onDispatch?.();
        return { success: true, totalTimeMs: 0 };
      },
    );
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServerHarness(
      socketPath,
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequestAfterConnect(
      socketPath,
      {
        id: randomUUID(),
        type: "mcp_request",
        method: "input/tap",
        params: {
          platform: "android",
          x: 1,
          y: 2,
        },
      },
      () => {
        const socketSessionId = server.sessionIds[0];
        mcpAutolockSessions.set(socketSessionId, session.sessionId);
      },
    );

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      coordinates: { x: 1, y: 2 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith({
      x: 1,
      y: 2,
      duration: undefined,
      timeoutMs: 30_000,
      perf: undefined,
      frameContext: undefined,
      onDispatch: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  test("serializes concurrent taps for the same device across socket clients", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestTapCoordinates = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true, totalTimeMs: 0 };
    });
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    fakeTimer.enableAutoAdvance();
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const [first, second] = await Promise.all([
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 1,
        y: 1,
      }),
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 2,
        y: 2,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestTapCoordinates).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails queued taps before dispatch when queue wait exceeds timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBlockingRequest = resolve;
    });
    const requestTapCoordinates = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        await blockingPromise;
      }
      return { success: true, totalTimeMs: 0 };
    });
    spyOnAndroidClientInstance(androidDevice, {
      requestTapCoordinates,
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const first = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const second = sendRequest(
      socketPath,
      "input/tap",
      {
        platform: "android",
        deviceId: "emulator-5554",
        x: 2,
        y: 2,
      },
      500,
    );

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    fakeTimer.advanceTime(600);
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");
    expect(requestTapCoordinates).toHaveBeenCalledTimes(1);
  });

  test("surfaces platform discovery failures before device targeting errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([], new Set()));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("Unable to discover booted android devices for input/tap");
  });

  test("rejects missing and non-numeric coordinates with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      y: 10,
    });
    const nonNumeric = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      x: "12",
      y: 10,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/tap requires numeric x and y params");
    expect(nonNumeric.success).toBe(false);
    expect(nonNumeric.error).toBe("input/tap requires numeric x and y params");
  });

  test("parseInputTapParams rejects non-finite x/y and non-integer duration (#3615)", () => {
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    // ±Infinity cannot survive a JSON round-trip (stringify -> null, parse rejects the
    // literal), so it only reaches the parser from a non-JSON in-process caller. Exercise
    // parseInputTapParams directly with the raw floats the parser is responsible for.
    const parseTap = (args: Record<string, unknown>): unknown => parseInputTapParams(args);

    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(() => parseTap({ platform: "android", x: bad, y: 10 })).toThrow(
        "input/tap requires numeric x and y params",
      );
      expect(() => parseTap({ platform: "android", x: 5, y: bad })).toThrow(
        "input/tap requires numeric x and y params",
      );
    }
    for (const duration of [Infinity, NaN, 1.5]) {
      expect(() => parseTap({ platform: "android", x: 5, y: 10, duration })).toThrow(
        "input/tap duration must be an integer number of milliseconds when provided",
      );
    }

    // Finite values still parse successfully (no over-rejection regression).
    expect(parseTap({ platform: "android", x: 5, y: 10, duration: 200 })).toMatchObject({
      platform: "android",
      x: 5,
      y: 10,
      duration: 200,
    });
  });

  test("accepts optional frameContext on every non-pointer input contract", () => {
    const target = {
      parseInputTypeTextParams,
      parseInputPressButtonParams,
      parseInputKeyParams,
    };

    expect(
      target.parseInputTypeTextParams({ platform: "android", text: "x", frameContext: "frame-A" })
        .frameContext,
    ).toBe("frame-A");
    expect(
      target.parseInputPressButtonParams({
        platform: "android",
        button: "home",
        frameContext: "frame-A",
      }).frameContext,
    ).toBe("frame-A");
    expect(
      target.parseInputKeyParams({ platform: "android", key: "enter", frameContext: "frame-A" })
        .frameContext,
    ).toBe("frame-A");
  });
  test("tracks direct input until a session-loss drain can safely finish", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const client = createAndroidTestClient(androidDevice);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "getScreenScaleMetadata").mockReturnValue(null);
    const deviceRequest = spyOn(client, "requestTapCoordinates").mockImplementation(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        args[0].signal?.throwIfAborted();
        args[0].onDispatch?.();
        sent = true;
        operationStarted.resolve();
        await releaseOperation.promise;
        return { success: true, totalTimeMs: 1 };
      },
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-tap-after-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      x: 1,
      y: 2,
      sessionUuid: sessionId,
    });
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    // Dispatch is latched exactly as in the real client; drain waits for its runner reply.
    expect(drained).toBe(false);
    releaseOperation.resolve();
    expect(await drain).toBe(true);
    const failure = await response;
    expect(failure.success).toBe(false);
    expect(failure.error).toContain("indeterminate");
    expect(sent).toBe(true);
    await deviceRequest.mock.results[0]!.value;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });

  test("a direct input cancelled before dispatch lets a session-loss drain finish at once and is never sent", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const client = createAndroidTestClient(androidDevice);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "getScreenScaleMetadata").mockReturnValue(null);
    const deviceRequest = spyOn(client, "requestTapCoordinates").mockImplementation(
      async (...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>) => {
        operationStarted.resolve();
        await releaseOperation.promise;
        args[0].signal?.throwIfAborted();
        args[0].onDispatch?.();
        sent = true;
        return { success: true, totalTimeMs: 1 };
      },
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-tap-before-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      x: 1,
      y: 2,
      sessionUuid: sessionId,
    });
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    expect(drained).toBe(true);
    expect(await drain).toBe(true);
    expect((await response).success).toBe(false);
    releaseOperation.resolve();
    await expect(deviceRequest.mock.results[0]!.value).rejects.toThrow();
    await drainMicrotasks(100);
    expect(sent).toBe(false);
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });
});
